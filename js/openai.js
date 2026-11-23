// OpenAI API ile konuşan yardımcı fonksiyonlar.

const BASE = 'https://api.openai.com/v1';

// Tahmini fiyatlar (USD). Maliyet sayacı için kullanılır, gerçek fatura OpenAI panelindedir.
const TEXT_PRICES = {
  // model adının başı: [1M giriş tokenı, 1M çıkış tokenı]
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5-mini': [0.25, 2],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
};
const TRANSCRIBE_PER_MIN = 0.003;
const TTS_PER_MIN = 0.015;

export function textCost(model, usage) {
  if (!usage) return 0;
  const key = Object.keys(TEXT_PRICES).find((k) => model.startsWith(k));
  const [pin, pout] = TEXT_PRICES[key] || TEXT_PRICES['gpt-5-mini'];
  // Önbellekten gelen giriş tokenları %90 indirimli
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const fresh = (usage.prompt_tokens || 0) - cached;
  return (fresh * pin + cached * pin * 0.1 + (usage.completion_tokens || 0) * pout) / 1e6;
}
export const transcribeCost = (seconds, settings) => (seconds / 60) * (settings && settings.transcribeQuality !== 'standard' ? 0.006 : TRANSCRIBE_PER_MIN);
export const ttsCost = (seconds) => (seconds / 60) * TTS_PER_MIN;

async function apiError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.error?.message || '';
  } catch { /* boş */ }
  if (res.status === 401) return new Error('API anahtarı geçersiz (401).');
  if (res.status === 429) return new Error('Kota veya kredi sorunu (429). Bakiyeni kontrol et.');
  if (res.status === 404) return new Error('Model bulunamadı (404). Ayarlar’dan model adını kontrol et. ' + detail);
  return new Error('OpenAI hatası ' + res.status + (detail ? ': ' + detail : ''));
}

export async function testApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) return { ok: false, message: 'Önce bir API anahtarı gir.' };
  try {
    const res = await fetch(BASE + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey.trim() },
    });
    if (res.ok) return { ok: true, message: 'Bağlantı çalışıyor.' };
    return { ok: false, message: (await apiError(res)).message };
  } catch (e) {
    return { ok: false, message: 'İnternete bağlanılamadı: ' + e.message };
  }
}

// Metin modelinden JSON cevap al
export async function chatJSON(settings, messages, maxTokens = 900, modelOverride = null) {
  const model = modelOverride || settings.models.chat;
  const body = {
    model,
    messages,
    response_format: { type: 'json_object' },
    max_completion_tokens: maxTokens,
  };
  // GPT-5 ailesinde düşünme süresini en aza indir (daha hızlı cevap)
  if (model.startsWith('gpt-5')) body.reasoning_effort = 'minimal';

  let res = await post('/chat/completions', settings.apiKey, body);
  if (!res.ok && res.status === 400 && body.reasoning_effort) {
    // Model bu ayarı desteklemiyorsa ayarsız tekrar dene
    delete body.reasoning_effort;
    res = await post('/chat/completions', settings.apiKey, body);
  }
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    data = { reply: content };
  }
  return { data, cost: textCost(model, j.usage) };
}

function post(path, apiKey, body) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Sesi yazıya çevir
export async function transcribe(settings, blob, hint) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, 'speech.' + ext);
  form.append('model', settings.models.transcribe);
  form.append('language', 'en');
  if (hint) form.append('prompt', hint);
  const res = await fetch(BASE + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.apiKey },
    body: form,
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  return (j.text || '').trim();
}

// Metni seslendir (mp3 döner).
// Seslendirme modeli kapanırsa (OpenAI 6 Ocak 2027'de kaldırıyor) sesli sohbet modeliyle seslendirilir.
export async function speak(settings, text, instructions) {
  if (!settings._ttsFallback) {
    const res = await post('/audio/speech', settings.apiKey, {
      model: settings.models.tts,
      voice: settings.voice,
      input: text,
      instructions,
      response_format: 'mp3',
    });
    if (res.ok) return res.blob();
    if (res.status === 401 || res.status === 429) throw await apiError(res);
    // Model bulunamadı / kaldırıldı → yedek yola geç (bu oturum boyunca)
    if (res.status !== 404 && res.status !== 400) throw await apiError(res);
    settings._ttsFallback = true;
  }
  return speakWithAudioModel(settings, text, instructions);
}

async function speakWithAudioModel(settings, text, instructions) {
  const res = await post('/chat/completions', settings.apiKey, {
    model: settings.models.audio,
    modalities: ['text', 'audio'],
    audio: { voice: settings.voice, format: 'mp3' },
    messages: [
      { role: 'system', content: 'You are a text-to-speech voice. Read the user\'s text aloud EXACTLY as written, word for word. Do not add, remove or change anything. ' + (instructions || '') },
      { role: 'user', content: text },
    ],
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const b64 = j.choices?.[0]?.message?.audio?.data;
  if (!b64) throw new Error('Ses üretilemedi.');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/mpeg' });
}

// Kullanılacak yazıya çevirme modeli (Ayarlar > Ses tanıma kalitesi)
export function transcribeModel(settings) {
  return settings.transcribeQuality === 'standard' ? settings.models.transcribe : settings.models.transcribeHigh;
}

/**
 * Sesi yazıya çevirir ve her kelime için güven değeri döndürür.
 * Dönen: { text, words: [{ w, p, start, end }] | null }
 */
export async function transcribeDetailed(settings, blob, { hint = '', language = 'en', logprobs = true } = {}) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'webm';
  const send = async (model, withLogprobs) => {
    const form = new FormData();
    form.append('file', blob, 'speech.' + ext);
    form.append('model', model);
    form.append('language', language);
    form.append('response_format', 'json');
    if (hint) form.append('prompt', hint);
    if (withLogprobs) form.append('include[]', 'logprobs');
    return fetch(BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey },
      body: form,
    });
  };
  let model = transcribeModel(settings);
  let res = await send(model, logprobs);
  // Model kaldırıldıysa veya güven değeri desteklenmiyorsa yeni modelle, güven değeri olmadan dene
  if (!res.ok && (res.status === 400 || res.status === 404)) {
    model = 'gpt-transcribe';
    res = await send(model, false);
  }
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const text = (j.text || '').trim();
  return { text, words: j.logprobs && j.logprobs.length ? wordConfidence(j.logprobs) : null };
}

// Token güven değerlerini kelimelere dağıt (kelimenin en düşük token olasılığı)
function wordConfidence(logprobs) {
  let full = '';
  const charP = [];
  logprobs.forEach((t) => {
    const tok = t.token || '';
    const p = Math.exp(t.logprob ?? 0);
    full += tok;
    for (let i = 0; i < tok.length; i++) charP.push(p);
  });
  const words = [];
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m;
  while ((m = re.exec(full))) {
    let p = 1;
    for (let i = m.index; i < m.index + m[0].length; i++) p = Math.min(p, charP[i] ?? 1);
    words.push({ w: m[0], p, start: m.index, end: m.index + m[0].length });
  }
  return { full, list: words };
}

// Kelimeler arasında emin olunamayanları seç (kısa kelimeler hariç)
export function uncertainWords(words, threshold = 0.6) {
  if (!words) return [];
  return words.list.filter((x) => x.p < threshold && x.w.length >= 3);
}

/**
 * Telaffuz değerlendirmesi (sesli girdi alabilen model ile)
 * wavB64: 16 kHz mono WAV (base64), target: söylenmesi gereken metin
 */
export async function assessPronunciation(settings, wavB64, target, level) {
  const model = settings.models.audio;
  const res = await post('/chat/completions', settings.apiKey, {
    model,
    modalities: ['text'],
    messages: [
      {
        role: 'system',
        content: `You are an expert English pronunciation coach for a Turkish speaker (level ${level}). The student tried to say the TARGET text. Listen carefully to the audio and judge ONLY pronunciation (sounds, stress, clarity), not grammar.
Be honest but encouraging. Typical Turkish-speaker issues: "th" (θ/ð) said as t/d or s/z, "w" said as "v", short vs long vowels (ship/sheep, full/fool), schwa /ə/, final consonant clusters, adding a vowel before "s+consonant" (e.g. "ıspeak"), word stress, silent letters.
If the audio is silent or clearly a different sentence, say so and give a low score.
Return ONLY a JSON object (no markdown):
{"score": 0-100, "summary_tr": "1-2 cümle Türkçe genel değerlendirme",
 "words": [{"word": "each word of the target in order", "ok": true or false, "issue_tr": "if not ok: what was wrong, in Turkish", "tip_tr": "if not ok: how to say it, in Turkish (mouth/tongue position, similar Turkish sound)", "say_like": "if not ok: simple Turkish-letter spelling of the correct sound, e.g. 'tenk yu' for 'thank you'"}]}`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'TARGET: ' + target },
          { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } },
        ],
      },
    ],
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  let data = {};
  try { data = JSON.parse(m ? m[0] : content); } catch { data = { summary_tr: content }; }
  // Tahmini maliyet (sesli girdi pahalıdır, yaklaşık)
  const u = j.usage || {};
  const audioIn = u.prompt_tokens_details?.audio_tokens || 0;
  const cost = (audioIn * 32 + Math.max(0, (u.prompt_tokens || 0) - audioIn) * 2.5 + (u.completion_tokens || 0) * 10) / 1e6;
  return { data, cost };
}

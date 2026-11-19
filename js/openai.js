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
  return ((usage.prompt_tokens || 0) * pin + (usage.completion_tokens || 0) * pout) / 1e6;
}
export const transcribeCost = (seconds) => (seconds / 60) * TRANSCRIBE_PER_MIN;
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
export async function chatJSON(settings, messages, maxTokens = 900) {
  const model = settings.models.chat;
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

// Metni seslendir (mp3 döner)
export async function speak(settings, text, instructions) {
  const res = await post('/audio/speech', settings.apiKey, {
    model: settings.models.tts,
    voice: settings.voice,
    input: text,
    instructions,
    response_format: 'mp3',
  });
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

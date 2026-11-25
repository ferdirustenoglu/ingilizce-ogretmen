// Yapay zekâ bağlantısı: OpenAI (varsayılan) veya Anthropic. JSON cevap alır, maliyeti hesaplar.

import { addCost } from './db.js';

const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';

// Tahmini fiyatlar, 1 milyon token için [giriş, çıkış, önbellekten giriş] USD
const PRICES = [
  ['gpt-5.6-sol', 4, 20, 0.4],
  ['gpt-5.6-terra', 2, 12, 0.2],
  ['gpt-5.6-luna', 0.2, 1.2, 0.02],
  ['gpt-5.5', 5, 30, 0.5],
  ['gpt-5-mini', 0.25, 2, 0.025],
  ['claude-opus', 5, 25, 0.5],
  ['claude-sonnet', 2, 10, 0.2],
  ['claude-haiku', 1, 5, 0.1],
];
function price(model) {
  const p = PRICES.find(([k]) => model.startsWith(k));
  return p ? p.slice(1) : [2, 12, 0.2];
}

export const activeModel = (s) => (s.provider === 'anthropic' ? s.anthropicModel : s.openaiModel);
export const hasKey = (s) => !!(s.provider === 'anthropic' ? s.anthropicKey : s.openaiKey);
export const canSpeak = (s) => !!s.openaiKey;

function friendlyError(status, detail) {
  if (status === 401) return 'API anahtarı geçersiz (401). Ayarlar’dan kontrol et.';
  if (status === 429) return 'Kota veya kredi sorunu (429). Bakiyeni kontrol et.';
  if (status === 404) return 'Model bulunamadı (404). Ayarlar’dan model adını kontrol et.';
  if (status === 529 || status === 503) return 'Yapay zekâ servisi şu an yoğun. Biraz sonra tekrar dene.';
  return 'Yapay zekâ hatası ' + status + (detail ? ': ' + detail : '');
}

async function errorOf(res) {
  let detail = '';
  try { const j = await res.json(); detail = j.error?.message || ''; } catch { /* boş */ }
  return new Error(friendlyError(res.status, detail));
}

// Metnin içindeki ilk JSON nesnesini çıkar
function parseJSON(text) {
  try { return JSON.parse(text); } catch { /* devam */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* devam */ }
  }
  throw new Error('Yapay zekâ cevabı okunamadı. Tekrar dene.');
}

/**
 * Sistem kuralları + kullanıcı mesajı gönderir, JSON döner.
 * opts: { maxTokens, effort: 'low' | 'medium' | 'minimal' }
 */
export async function askJSON(settings, system, user, opts = {}) {
  const maxTokens = opts.maxTokens || 3000;
  if (settings.provider === 'anthropic') return askAnthropic(settings, system, user, maxTokens);
  return askOpenAI(settings, system, user, maxTokens, opts.effort || 'low');
}

async function askOpenAI(settings, system, user, maxTokens, effort) {
  if (!settings.openaiKey) throw new Error('Önce Ayarlar’dan OpenAI API anahtarını gir.');
  const model = settings.openaiModel;
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_completion_tokens: maxTokens,
  };
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning_effort = effort;
  const send = () => fetch(OPENAI + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res = await send();
  if (!res.ok && res.status === 400 && body.reasoning_effort) {
    delete body.reasoning_effort; // model bu ayarı desteklemiyorsa
    res = await send();
  }
  if (!res.ok) throw await errorOf(res);
  const j = await res.json();
  const u = j.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  const [pin, pout, pcache] = price(model);
  const cost = (((u.prompt_tokens || 0) - cached) * pin + cached * pcache + (u.completion_tokens || 0) * pout) / 1e6;
  await addCost(cost);
  const msg = j.choices?.[0]?.message?.content || '';
  if (!msg) throw new Error('Yapay zekâ boş cevap verdi. Tekrar dene.');
  return { data: parseJSON(msg), cost };
}

async function askAnthropic(settings, system, user, maxTokens) {
  if (!settings.anthropicKey) throw new Error('Önce Ayarlar’dan Anthropic API anahtarını gir.');
  const model = settings.anthropicModel;
  const res = await fetch(ANTHROPIC + '/messages', {
    method: 'POST',
    headers: {
      'x-api-key': settings.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user + '\n\nReply with the JSON object only.' }],
    }),
  });
  if (!res.ok) throw await errorOf(res);
  const j = await res.json();
  const u = j.usage || {};
  const [pin, pout, pcache] = price(model);
  const cost = ((u.input_tokens || 0) * pin + (u.cache_creation_input_tokens || 0) * pin * 1.25
    + (u.cache_read_input_tokens || 0) * pcache + (u.output_tokens || 0) * pout) / 1e6;
  await addCost(cost);
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { data: parseJSON(text), cost };
}

// Anahtar testi
export async function testConnection(settings) {
  try {
    const { data } = await askJSON(settings, 'Reply with JSON only.', 'Return {"ok": true}.', { maxTokens: 400, effort: 'low' });
    return data && data.ok ? { ok: true, message: 'Bağlantı çalışıyor (' + activeModel(settings) + ').' } : { ok: true, message: 'Bağlantı çalışıyor.' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ---------- Seslendirme (OpenAI) ----------
const audioCache = new Map();
let current = null;

export function stopAudio() {
  if (current) { current.pause(); current = null; }
}

export async function speak(settings, text, slow = false) {
  if (!settings.openaiKey) throw new Error('Dinlemek için Ayarlar’a OpenAI anahtarı gerekir.');
  stopAudio();
  const key = (slow ? 's|' : 'n|') + text;
  let url = audioCache.get(key);
  if (!url) {
    const res = await fetch(OPENAI + '/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ttsModel,
        voice: settings.voice,
        input: text,
        instructions: slow
          ? 'Speak clearly and slowly, like a teacher reading to a learner. Natural intonation.'
          : 'Speak naturally and clearly, at a normal conversational pace.',
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw await errorOf(res);
    const blob = await res.blob();
    url = URL.createObjectURL(blob);
    audioCache.set(key, url);
    addCost((text.length / 15 / 150) * 0.015); // kaba tahmin: ~150 kelime/dk
  }
  current = new Audio(url);
  current.playbackRate = slow ? 0.85 : 1;
  await current.play();
}

// ---------- Sesli yazma (OpenAI ses → yazı) ----------
// Hatalar DÜZELTİLMEDEN, söylendiği gibi yazıya çevrilir (kontrolün anlamı kalsın diye).
export async function transcribe(settings, blob, seconds) {
  if (!settings.openaiKey) throw new Error('Sesli yazma için Ayarlar’a OpenAI anahtarı gerekir.');
  const form = new FormData();
  const ext = (blob.type || '').includes('mp4') ? 'mp4' : (blob.type || '').includes('ogg') ? 'ogg' : 'webm';
  form.append('file', blob, 'ses.' + ext);
  form.append('model', settings.sttModel || 'gpt-4o-transcribe');
  form.append('language', 'en');
  form.append('prompt', 'A Turkish learner is saying one English sentence. Write exactly the words spoken, keeping any grammar mistakes. Do not correct, complete or improve the sentence.');
  form.append('response_format', 'json');
  const res = await fetch(OPENAI + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.openaiKey },
    body: form,
  });
  if (!res.ok) throw await errorOf(res);
  const j = await res.json();
  addCost((Math.max(1, seconds || 5) / 60) * 0.006);
  return String(j.text || '').trim();
}

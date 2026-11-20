// Ses yardımcıları: metni seslendirip çalma, kaydı WAV'a çevirme, basılı tutarak kayıt

import { speak, ttsCost } from './openai.js';
import { ttsInstructions, playbackRate } from './teacher.js';
import { addCost } from './db.js';

const cache = new Map(); // metin+hız → ses adresi
let current = null;

export function stopPlayback() {
  if (current) { current.pause(); current = null; }
}

/**
 * Metni öğretmenin sesiyle çalar. speed: 'slow' | 'normal' | undefined (ayara göre)
 */
export async function playText(settings, level, text, speed) {
  stopPlayback();
  const key = (speed || 'auto') + '|' + text;
  let url = cache.get(key);
  const s = speed ? { ...settings, speed } : settings;
  if (!url) {
    const blob = await speak(settings, text, ttsInstructions(s, level));
    url = URL.createObjectURL(blob);
    cache.set(key, url);
    const probe = new Audio(url);
    probe.addEventListener('loadedmetadata', () => { if (isFinite(probe.duration)) addCost(ttsCost(probe.duration)); });
  }
  current = new Audio(url);
  current.preservesPitch = true;
  current.playbackRate = playbackRate(s, level);
  await current.play();
  return current;
}

// Kaydı 16 kHz mono WAV'a çevirir, base64 döner (sesli girdi alan model WAV/MP3 ister)
export async function toWavBase64(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close();
  }
  const rate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(bytes);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  // base64
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), seconds: decoded.duration };
}

/**
 * Bir düğmeyi "basılı tut ve konuş" düğmesine çevirir.
 * Kendi mikrofon akışını açar, kayıt bitince kapatır (mikrofon simgesi boşuna yanmaz).
 * handlers: { onStart(), onStop(blob, seconds), onError(msg), canStart() }
 */
export function holdToRecord(btn, handlers) {
  let stream = null;
  let rec = null;
  let chunks = [];
  let t0 = 0;
  let active = false;
  let wantStop = false;

  const stopTracks = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };

  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    if (active || (handlers.canStart && !handlers.canStart())) return;
    active = true;
    wantStop = false;
    try { btn.setPointerCapture(e.pointerId); } catch { /* yok */ }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      active = false;
      handlers.onError && handlers.onError('Mikrofona erişilemedi. Tarayıcı izinlerini kontrol et.');
      return;
    }
    if (wantStop) { stopTracks(); active = false; handlers.onError && handlers.onError('Düğmeyi basılı tutarak konuş.'); return; }
    chunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      const seconds = (performance.now() - t0) / 1000;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      stopTracks();
      active = false;
      if (seconds < 0.5 || blob.size < 800) handlers.onError && handlers.onError('Çok kısa oldu. Düğmeyi basılı tutarak konuş.');
      else handlers.onStop(blob, seconds);
    };
    rec.start();
    t0 = performance.now();
    if (navigator.vibrate) navigator.vibrate(20);
    handlers.onStart && handlers.onStart();
  });
  const release = () => {
    if (!active) return;
    if (rec && rec.state === 'recording') rec.stop();
    else wantStop = true;
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
}

// Ders ekranı – Aşama 2: Bas-Konuş modu
// Akış: basılı tut → kayıt → yazıya çevir → önizleme (Gönder/İptal) → öğretmen cevabı → seslendirme

import { db, saveProfile, addCost } from './db.js';
import { topicById } from './topics.js';
import { chatJSON, transcribe, speak, transcribeCost, ttsCost } from './openai.js';
import { buildTeacherSystem, ttsInstructions } from './teacher.js';

let ctx = null; // { app, state, esc, toast, ICON }
let lesson = null;
let stream = null;
let recorder = null;
let chunks = [];
let recStart = 0;
let recording = false;
let audio = null;
let status = 'idle'; // idle | recording | transcribing | preview | thinking | speaking | error
let pending = null; // { text }
let lastError = null;
const audioUrls = new Map(); // mesaj id → ses adresi (tekrar dinlemek için)

const HISTORY_LIMIT = 24;

const newLesson = () => ({ id: Date.now(), startedAt: new Date().toISOString(), messages: [], wordStatus: {}, cost: 0 });

export async function renderLesson(c) {
  ctx = c;
  lesson = (await db.get('lesson')) || newLesson();
  status = 'idle';
  pending = null;
  lastError = null;
  draw();
  await openMic();
  if (!lesson.messages.length) teacherTurn();
}

// Dersten çıkarken mikrofonu ve sesi kapat
export function leaveLesson() {
  stopAudio();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recording = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------- Çizim ----------
function draw() {
  const { app, state, esc, ICON } = ctx;
  const topics = state.study.topics.map(topicById).filter(Boolean);
  const realtimeNote = state.settings.voiceMode === 'realtime'
    ? `<div class="note" style="margin:0 16px">Canlı Sohbet modu Aşama 4'te gelecek. Şimdilik ders Bas-Konuş ile yapılıyor.</div>`
    : '';

  app.innerHTML = `
  <div class="lesson">
    <header class="lesson-head">
      <a href="#home" class="icon-btn" aria-label="Ana sayfaya dön (ders kaydedilir)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </a>
      <span class="lvl-pill">${esc(state.profile.level)}</span>
      <span class="mode-chip">${ICON.micSmall} Bas-Konuş</span>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-small" id="newLesson">Yeni Ders</button>
    </header>
    <div class="lesson-topic">${topics.length ? esc(topics.map((t) => t.title).join(' · ')) : 'Serbest sohbet'}</div>
    ${realtimeNote}
    <div class="msgs" id="msgs"></div>
    <section class="chips" id="chips" aria-label="Günün kelimeleri"></section>
    <div id="preview"></div>
    <footer class="lesson-foot">
      <button type="button" class="talk" id="talk"></button>
      <p class="talk-status" id="talkStatus" aria-live="polite"></p>
    </footer>
  </div>`;

  drawMessages();
  drawChips();
  drawPreview();
  drawTalk();

  app.querySelector('#newLesson').addEventListener('click', startNewLesson);

  const talk = app.querySelector('#talk');
  talk.addEventListener('contextmenu', (e) => e.preventDefault());
  talk.addEventListener('pointerdown', onPress);
  talk.addEventListener('pointerup', onRelease);
  talk.addEventListener('pointercancel', onRelease);
  talk.addEventListener('pointerleave', () => { if (recording) onRelease(); });
}

function drawMessages() {
  const box = ctx.app.querySelector('#msgs');
  if (!box) return;
  const { esc } = ctx;
  const html = lesson.messages.map((m) => {
    if (m.role === 'teacher') {
      return `<div class="bubble bubble-t">
        <span>${esc(m.text)}</span>
        <button type="button" class="replay" data-replay="${m.id}" aria-label="Tekrar dinle">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
        </button>
      </div>`;
    }
    const c = m.correction;
    return `<div class="bubble bubble-s">${esc(m.text)}</div>
      ${c ? `<div class="corr">
        <div class="corr-h">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          Düzeltme${c.important === false ? ' (küçük)' : ''}
        </div>
        <p class="corr-old">${esc(c.original || m.text)}</p>
        <p class="corr-new">${esc(c.corrected || '')}</p>
        ${c.note_tr ? `<p class="corr-note">${esc(c.note_tr)}</p>` : ''}
      </div>` : ''}`;
  }).join('');

  const thinking = status === 'thinking'
    ? '<div class="bubble bubble-t typing" aria-label="Öğretmen düşünüyor"><span></span><span></span><span></span></div>'
    : '';
  const err = lastError
    ? `<div class="err-box"><p>${esc(lastError)}</p><button type="button" class="btn btn-small" id="retry">Tekrar dene</button></div>`
    : '';

  box.innerHTML = html + thinking + err;
  box.querySelectorAll('[data-replay]').forEach((b) => b.addEventListener('click', () => replay(+b.dataset.replay)));
  box.querySelector('#retry')?.addEventListener('click', () => { lastError = null; teacherTurn(); });
  box.scrollTop = box.scrollHeight;
}

function drawChips() {
  const box = ctx.app.querySelector('#chips');
  if (!box) return;
  const words = ctx.state.study.words;
  if (!words.length) { box.innerHTML = ''; return; }
  const ok = words.filter((w) => lesson.wordStatus[w.toLowerCase()] === 'ok').length;
  box.innerHTML = `
    <div class="row-between small" style="font-weight:600"><span>Günün kelimeleri</span><span>${ok} / ${words.length}</span></div>
    <div class="chip-row">${words.map((w) => {
      const s = lesson.wordStatus[w.toLowerCase()];
      const cls = s === 'ok' ? 'chip chip-ok' : s === 'bad' ? 'chip chip-bad' : 'chip';
      const mark = s === 'ok' ? ' ✓' : s === 'bad' ? ' !' : '';
      return `<span class="${cls}">${ctx.esc(w)}${mark}</span>`;
    }).join('')}</div>`;
}

function drawPreview() {
  const box = ctx.app.querySelector('#preview');
  if (!box) return;
  if (status !== 'preview' || !pending) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <section class="preview" aria-label="Gönderilmeden önce önizleme">
      <p class="small" style="color:var(--accent-text); font-weight:700">Anladığım cümle — doğru mu?</p>
      <p style="font-size:16px; line-height:1.45">${ctx.esc(pending.text)}</p>
      <div class="row">
        <button type="button" class="btn btn-small" style="flex:1" id="cancelSend">İptal, tekrar söyle</button>
        <button type="button" class="btn btn-small btn-send" style="flex:1" id="send">Gönder</button>
      </div>
    </section>`;
  box.querySelector('#cancelSend').addEventListener('click', () => { pending = null; setStatus('idle'); });
  box.querySelector('#send').addEventListener('click', sendPending);
}

function drawTalk() {
  const talk = ctx.app.querySelector('#talk');
  const st = ctx.app.querySelector('#talkStatus');
  if (!talk) return;
  const labels = {
    idle: ['Basılı tut ve konuş', 'Bırakınca cümlen yazıya çevrilir'],
    recording: ['Dinliyorum…', 'Bitince parmağını kaldır'],
    transcribing: ['Yazıya çeviriyorum…', ''],
    preview: ['Basılı tut ve yeniden söyle', 'Ya da yukarıdan gönder'],
    thinking: ['Öğretmen düşünüyor…', ''],
    speaking: ['Durdur', 'Öğretmen konuşuyor'],
    error: ['Basılı tut ve konuş', ''],
  };
  const [label, sub] = labels[status] || labels.idle;
  talk.innerHTML = (status === 'speaking'
    ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : ctx.ICON.mic.replace('width="22" height="22"', 'width="28" height="28"')) + `<span>${label}</span>`;
  talk.className = 'talk' + (status === 'recording' ? ' talk-rec' : '');
  talk.disabled = status === 'transcribing' || status === 'thinking';
  st.textContent = stream ? sub : 'Mikrofon izni gerekiyor: düğmeye bas';
}

function setStatus(s) {
  status = s;
  drawTalk();
  drawPreview();
  if (s === 'thinking' || s === 'idle') drawMessages();
}

// ---------- Mikrofon ----------
async function openMic() {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    drawTalk();
    return true;
  } catch (e) {
    ctx.toast('Mikrofona erişilemedi. Tarayıcı izinlerini kontrol et.');
    drawTalk();
    return false;
  }
}

async function onPress(e) {
  e.preventDefault();
  if (status === 'speaking') { stopAudio(); setStatus('idle'); return; }
  if (status === 'transcribing' || status === 'thinking') return;
  if (!stream) { await openMic(); return; }
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* yok */ }
  chunks = [];
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  recorder.onstop = onRecordStop;
  recorder.start();
  recStart = performance.now();
  recording = true;
  if (navigator.vibrate) navigator.vibrate(20);
  setStatus('recording');
}

function onRelease() {
  if (!recording) return;
  recording = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onRecordStop() {
  const seconds = (performance.now() - recStart) / 1000;
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  if (seconds < 0.6 || blob.size < 1000) {
    ctx.toast('Çok kısa oldu. Düğmeyi basılı tutarak konuş.');
    setStatus(pending ? 'preview' : 'idle');
    return;
  }
  setStatus('transcribing');
  const { settings, study } = ctx.state;
  try {
    const hint = 'An English learner speaking English.' + (study.words.length ? ' Words: ' + study.words.join(', ') + '.' : '');
    const text = await transcribe(settings, blob, hint);
    await addLessonCost(transcribeCost(seconds));
    if (!text) {
      ctx.toast('Ses anlaşılamadı, tekrar dene.');
      setStatus('idle');
      return;
    }
    pending = { text };
    setStatus('preview');
  } catch (err) {
    ctx.toast(err.message);
    setStatus('idle');
  }
}

// ---------- Öğretmen ----------
async function sendPending() {
  if (!pending) return;
  const msg = { id: Date.now(), role: 'student', text: pending.text };
  pending = null;
  lesson.messages.push(msg);
  ctx.state.profile.sentenceCount = (ctx.state.profile.sentenceCount || 0) + 1;
  await saveProfile(ctx.state.profile);
  await saveLesson();
  teacherTurn();
}

async function teacherTurn() {
  const { state } = ctx;
  if (!state.settings.apiKey) {
    lastError = 'API anahtarı yok. Ayarlar’dan gir.';
    setStatus('idle');
    return;
  }
  lastError = null;
  setStatus('thinking');

  const history = lesson.messages.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role === 'teacher' ? 'assistant' : 'user',
    content: m.text,
  }));
  if (!lesson.messages.length) history.push({ role: 'user', content: '[START_LESSON]' });

  const messages = [{ role: 'system', content: buildTeacherSystem(state) }, ...history];

  let data;
  try {
    const r = await chatJSON(state.settings, messages);
    data = r.data;
    await addLessonCost(r.cost);
  } catch (err) {
    lastError = err.message;
    setStatus('idle');
    return;
  }

  const reply = String(data.reply || '').trim() || 'Sorry, could you say that again?';

  // Son öğrenci mesajına düzeltmeyi ekle
  const last = lesson.messages[lesson.messages.length - 1];
  if (last && last.role === 'student' && data.correction && data.correction.corrected) {
    last.correction = data.correction;
  }
  // Kelime durumlarını güncelle
  const targets = new Set(state.study.words.map((w) => w.toLowerCase()));
  (data.words_used_ok || []).forEach((w) => {
    const k = String(w).toLowerCase();
    if (targets.has(k)) lesson.wordStatus[k] = 'ok';
  });
  (data.words_used_wrong || []).forEach((w) => {
    const k = String(w).toLowerCase();
    if (targets.has(k) && lesson.wordStatus[k] !== 'ok') lesson.wordStatus[k] = 'bad';
  });

  const tmsg = { id: Date.now(), role: 'teacher', text: reply };
  lesson.messages.push(tmsg);
  await saveLesson();
  drawMessages();
  drawChips();
  await say(tmsg);
}

async function say(msg) {
  const { state } = ctx;
  stopAudio();
  setStatus('speaking');
  try {
    let url = audioUrls.get(msg.id);
    if (!url) {
      const blob = await speak(state.settings, msg.text, ttsInstructions(state.settings, state.profile.level));
      url = URL.createObjectURL(blob);
      audioUrls.set(msg.id, url);
      // Süre bilinince maliyeti ekle
      const probe = new Audio(url);
      probe.addEventListener('loadedmetadata', () => {
        if (isFinite(probe.duration)) addLessonCost(ttsCost(probe.duration));
      });
    }
    audio = new Audio(url);
    audio.addEventListener('ended', () => { if (status === 'speaking') setStatus('idle'); });
    await audio.play();
  } catch (err) {
    ctx.toast('Seslendirme hatası: ' + err.message);
    setStatus('idle');
  }
}

function replay(id) {
  if (status === 'recording' || status === 'transcribing' || status === 'thinking') return;
  const msg = lesson.messages.find((m) => m.id === id);
  if (msg) say(msg);
}

function stopAudio() {
  if (audio) {
    audio.pause();
    audio = null;
  }
}

// ---------- Kayıt ----------
async function saveLesson() {
  await db.set('lesson', lesson);
}

async function addLessonCost(usd) {
  if (!usd) return;
  lesson.cost = (lesson.cost || 0) + usd;
  await addCost(usd);
  await saveLesson();
}

async function startNewLesson() {
  if (status === 'thinking' || status === 'transcribing') return;
  if (lesson.messages.length && !confirm('Bu ders bitsin ve yeni ders başlasın mı?')) return;
  stopAudio();
  if (lesson.messages.length) {
    const archive = (await db.get('lessons')) || [];
    archive.unshift({ ...lesson, endedAt: new Date().toISOString() });
    await db.set('lessons', archive.slice(0, 30));
  }
  audioUrls.forEach((u) => URL.revokeObjectURL(u));
  audioUrls.clear();
  lesson = newLesson();
  pending = null;
  lastError = null;
  await saveLesson();
  draw();
  teacherTurn();
}

// Ayarlardaki "Sesi dinle" düğmesi için
export async function previewVoice(settings, level) {
  const blob = await speak(settings, "Hello! I'm your English teacher. Let's practise speaking together.", ttsInstructions(settings, level));
  const a = new Audio(URL.createObjectURL(blob));
  await a.play();
  await addCost(ttsCost(4));
}


// Ders ekranı: iki mod
//  - Bas-Konuş (ptt): basılı tut → kayıt → yazıya çevir → önizleme → öğretmen (JSON) → seslendirme
//  - Canlı Sohbet (live): Realtime API ile WebRTC üzerinden doğrudan sesli sohbet

import { db, saveProfile, addCost } from './db.js';
import { topicById, LEVELS } from './topics.js';
import { chatJSON, transcribeDetailed, uncertainWords, transcribeModel, speak, transcribeCost, ttsCost } from './openai.js';
import { addPronWords } from './pron.js';
import { playText, holdToRecord, stopPlayback } from './audio.js';
import { buildTeacherSystem, ttsInstructions, playbackRate, realtimeSpeed, liveSpeechStyle } from './teacher.js';
import {
  analyzeSentence, pickFocusMistakes, pickReviewWords, registerWords, recordWordUse, loadMistakes,
} from './analysis.js';
import { connectRealtime } from './realtime.js';

let ctx = null; // { app, state, esc, toast, ICON }
let lesson = null;
let mode = 'ptt';
let lastError = null;

// Bas-Konuş durumu
let stream = null;
let recorder = null;
let chunks = [];
let recStart = 0;
let recording = false;
let audio = null;
let status = 'idle'; // idle | recording | transcribing | preview | thinking | speaking
let pending = null;
const audioUrls = new Map();

// Canlı Sohbet durumu
let rt = null;
let liveStatus = 'idle'; // connecting | live | paused | error
let speaking = false;
let listening = false;
let noticeSent = null;
let drawQueued = false;

const HISTORY_LIMIT = 24;

const newLesson = () => ({
  id: Date.now(), startedAt: new Date().toISOString(), messages: [], wordStatus: {}, cost: 0,
});

async function prepareLesson(l) {
  const words = ctx.state.study.words;
  await registerWords(words);
  l.focusMistakes = await pickFocusMistakes(2);
  l.reviewWords = await pickReviewWords(words, 5);
  l.levelStart = ctx.state.profile.level;
  l.topics = [...ctx.state.study.topics];
  l.words = [...words];
  return l;
}

const allTargets = () => [...ctx.state.study.words, ...(lesson.reviewWords || [])];

// ---------- Giriş / çıkış ----------
export async function renderLesson(c) {
  ctx = c;
  mode = ctx.state.settings.voiceMode === 'realtime' ? 'live' : 'ptt';
  lesson = (await db.get('lesson')) || (await prepareLesson(newLesson()));
  if (!lesson.levelStart) lesson.levelStart = ctx.state.profile.level;
  await saveLesson();
  status = 'idle';
  pending = null;
  lastError = null;
  liveStatus = 'idle';
  speaking = false;
  listening = false;
  draw();
  if (!ctx.state.settings.apiKey) {
    lastError = 'API anahtarı yok. Ayarlar’dan gir.';
    drawMessages();
    return;
  }
  if (mode === 'live') {
    connectLive();
  } else {
    await openMic();
    if (!lesson.messages.length) teacherTurn();
  }
}

export function leaveLesson() {
  stopAudio();
  howSayState = null;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recording = false;
  closeLive();
  stopStream();
  liveStatus = 'idle';
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------- Çizim ----------
function draw() {
  const { app, state, esc, ICON } = ctx;
  const topics = state.study.topics.map(topicById).filter(Boolean);
  const modeChip = mode === 'live' ? `${ICON.bolt} Canlı Sohbet` : `${ICON.micSmall} Bas-Konuş`;

  app.innerHTML = `
  <div class="lesson">
    <header class="lesson-head">
      <a href="#home" class="icon-btn" aria-label="Ana sayfaya dön (ders kaydedilir)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </a>
      <span class="lvl-pill">${esc(state.profile.level)}</span>
      <span class="mode-chip">${modeChip}</span>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-small" id="endLesson">Dersi Bitir</button>
    </header>
    <div class="lesson-topic">${topics.length ? esc(topics.map((t) => t.title).join(' · ')) : 'Serbest sohbet'}</div>
    <div class="msgs" id="msgs"></div>
    <section class="chips" id="chips" aria-label="Günün kelimeleri"></section>
    <div id="preview"></div>
    <div class="helpers"><button type="button" class="help-btn" id="howSay">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>
      Nasıl denir?</button><span class="small">Öğretmenin cümlesine dokun: Türkçesi çıkar</span></div>
    <footer class="lesson-foot" id="foot"></footer>
    <div id="sheet"></div>
  </div>`;

  drawMessages();
  drawChips();
  drawPreview();
  drawFooter();
  app.querySelector('#endLesson').addEventListener('click', endLesson);
  app.querySelector('#howSay').addEventListener('click', openHowSay);
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawMessages(); });
}

function drawMessages() {
  const box = ctx.app.querySelector('#msgs');
  if (!box || !lesson) return;
  const { esc } = ctx;
  const html = lesson.messages.map((m) => {
    if (m.role === 'teacher') {
      const replayBtn = mode === 'ptt'
        ? `<button type="button" class="replay" data-replay="${m.id}" aria-label="Tekrar dinle">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
          </button>`
        : '';
      const tr = m.tr && !m.trHidden ? `<span class="tr-line">${esc(m.tr)}</span>` : (m.trLoading ? '<span class="tr-line">Çevriliyor…</span>' : '');
      const body = (m.say ? `<span class="t-corr">${fmtTeacher(m.say)}</span>` : '') + `<span class="t-main">${fmtTeacher(m.text) || '…'}</span>`;
      return `<div class="bubble bubble-t"><span class="t-text" data-tr="${m.id}" role="button" tabindex="0" aria-label="Türkçesini göster">${body}${tr}</span>${replayBtn}</div>`;
    }
    if (m.pending) return '<div class="bubble bubble-s typing" aria-label="Söylediğin yazıya çevriliyor"><span></span><span></span><span></span></div>';
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

  const thinking = mode === 'ptt' && status === 'thinking'
    ? '<div class="bubble bubble-t typing" aria-label="Öğretmen düşünüyor"><span></span><span></span><span></span></div>'
    : '';
  const err = lastError
    ? `<div class="err-box"><p>${esc(lastError)}</p>${ctx.state.settings.apiKey ? '<button type="button" class="btn btn-small" id="retry">Tekrar dene</button>' : '<a class="btn btn-small" href="#settings">Ayarlara git</a>'}</div>`
    : '';
  const connecting = !lesson.messages.length && !err && mode === 'live' && liveStatus === 'connecting'
    ? '<p class="muted" style="text-align:center; margin-top:24px">Öğretmene bağlanılıyor…</p>'
    : '';

  box.innerHTML = html + thinking + err + connecting;
  box.querySelectorAll('[data-replay]').forEach((b) => b.addEventListener('click', () => replay(+b.dataset.replay)));
  box.querySelectorAll('[data-tr]').forEach((el) => el.addEventListener('click', () => toggleTranslate(+el.dataset.tr)));
  box.querySelector('#retry')?.addEventListener('click', () => {
    lastError = null;
    if (mode === 'live') connectLive(); else teacherTurn();
  });
  box.scrollTop = box.scrollHeight;
}

function drawChips() {
  const box = ctx.app.querySelector('#chips');
  if (!box || !lesson) return;
  const words = ctx.state.study.words;
  const review = lesson.reviewWords || [];
  if (!words.length && !review.length) { box.innerHTML = ''; return; }
  const ok = words.filter((w) => lesson.wordStatus[w.toLowerCase()] === 'ok').length;
  box.innerHTML = `
    <div class="row-between small" style="font-weight:600"><span>Günün kelimeleri${review.length ? ` <span style="color:var(--accent-text)">+ ${review.length} tekrar</span>` : ''}</span><span>${ok} / ${words.length}</span></div>
    <div class="chip-row">${[...words, ...review].map((w, i) => {
      const isReview = i >= words.length;
      const s = lesson.wordStatus[w.toLowerCase()];
      const cls = (s === 'ok' ? 'chip chip-ok' : s === 'bad' ? 'chip chip-bad' : 'chip') + (isReview && !s ? ' chip-review' : '');
      const mark = s === 'ok' ? ' ✓' : s === 'bad' ? ' !' : '';
      return `<span class="${cls}">${ctx.esc(w)}${mark}</span>`;
    }).join('')}</div>`;
}

function drawPreview() {
  const box = ctx.app.querySelector('#preview');
  if (!box) return;
  if (mode !== 'ptt' || status !== 'preview' || !pending) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <section class="preview" aria-label="Gönderilmeden önce önizleme">
      <p class="small" style="color:var(--accent-text); font-weight:700">Anladığım cümle — doğru mu?</p>
      <p style="font-size:16px; line-height:1.45">${previewText(pending)}</p>
      ${pending.unsure && pending.unsure.length ? `<p class="unsure-note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.5"/></svg>
        <span>Altı çizili kelimeleri net anlayamadım. Telaffuz Çalışması listene ekledim.</span></p>` : ''}
      <div class="row">
        <button type="button" class="btn btn-small" style="flex:1" id="cancelSend">İptal, tekrar söyle</button>
        <button type="button" class="btn btn-small btn-send" style="flex:1" id="send">Gönder</button>
      </div>
    </section>`;
  box.querySelector('#cancelSend').addEventListener('click', () => { pending = null; setStatus('idle'); });
  box.querySelector('#send').addEventListener('click', sendPending);
}

// Öğretmen metni: tırnak içindeki İngilizce turuncu, paragraflar ayrı
function fmtTeacher(text) {
  if (!text) return '';
  const esc = ctx.esc(text);
  const quoted = esc.replace(/(&quot;|“|”|«)([^"“”«»]{1,160}?)(&quot;|”|“|»)/g, '<span class="q">$2</span>');
  return quoted.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<span class="para">${p}</span>`).join('');
}

// Önizleme metni: emin olunamayan kelimelerin altı çizili
function previewText(p) {
  const esc = ctx.esc;
  if (!p.words || !p.unsure || !p.unsure.length) return esc(p.text);
  const full = p.words.full;
  let out = '';
  let i = 0;
  p.unsure.forEach((u) => {
    out += esc(full.slice(i, u.start)) + `<mark class="unsure">${esc(full.slice(u.start, u.end))}</mark>`;
    i = u.end;
  });
  return (out + esc(full.slice(i))).trim();
}

function drawFooter() {
  const foot = ctx.app.querySelector('#foot');
  if (!foot) return;
  if (mode === 'live') { drawLiveFooter(foot); return; }

  const labels = {
    idle: ['Basılı tut ve konuş', 'Bırakınca cümlen yazıya çevrilir'],
    recording: ['Dinliyorum…', 'Bitince parmağını kaldır'],
    transcribing: ['Yazıya çeviriyorum…', ''],
    preview: ['Basılı tut ve yeniden söyle', 'Ya da yukarıdan gönder'],
    thinking: ['Öğretmen düşünüyor…', ''],
    speaking: ['Basılı tut ve konuş', 'Öğretmen konuşuyor · basarsan susar'],
  };
  const [label, sub] = labels[status] || labels.idle;
  const icon = ctx.ICON.mic.replace('width="22" height="22"', 'width="28" height="28"');

  let talk = foot.querySelector('#talk');
  if (!talk) {
    foot.innerHTML = '<button type="button" class="talk" id="talk"></button><p class="talk-status" id="talkStatus" aria-live="polite"></p>';
    talk = foot.querySelector('#talk');
    talk.addEventListener('contextmenu', (e) => e.preventDefault());
    talk.addEventListener('pointerdown', onPress);
    talk.addEventListener('pointerup', onRelease);
    talk.addEventListener('pointercancel', onRelease);
    talk.addEventListener('pointerleave', () => { if (recording) onRelease(); });
  }
  talk.innerHTML = icon + `<span>${label}</span>`;
  talk.className = 'talk' + (status === 'recording' ? ' talk-rec' : '');
  talk.disabled = status === 'transcribing' || status === 'thinking';
  foot.querySelector('#talkStatus').textContent = stream ? sub : 'Mikrofon izni gerekiyor: düğmeye bas';
}

function drawLiveFooter(foot) {
  let label;
  let sub;
  let cls = 'live-btn';
  let icon;
  const pauseIcon = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
  const playIcon = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const micIcon = ctx.ICON.mic.replace('width="22" height="22"', 'width="30" height="30"');
  if (liveStatus === 'connecting') {
    label = 'Bağlanıyor'; sub = 'Öğretmene bağlanılıyor…'; icon = micIcon; cls += ' live-wait';
  } else if (liveStatus === 'live') {
    label = 'Duraklat'; icon = pauseIcon;
    if (speaking) { sub = 'Öğretmen konuşuyor · istersen sözünü kesebilirsin'; cls += ' live-speak'; }
    else if (listening) { sub = 'Seni dinliyorum…'; cls += ' live-listen'; }
    else sub = 'Konuşabilirsin · duraklatmak için dokun';
  } else {
    label = 'Devam Et'; icon = playIcon;
    sub = liveStatus === 'error' ? 'Bağlantı durdu · devam etmek için dokun' : (liveStatus === 'paused' ? 'Ders duraklatıldı · ücret yazmıyor' : 'Başlamak için dokun');
  }
  foot.innerHTML = `
    <div class="live-wrap">
      <span class="wave ${listening || speaking ? 'wave-on' : ''}" aria-hidden="true"><i></i><i></i><i></i></span>
      <button type="button" class="${cls}" id="liveBtn" aria-label="${label}" ${liveStatus === 'connecting' ? 'disabled' : ''}>${icon}</button>
      <span class="wave ${listening || speaking ? 'wave-on' : ''}" aria-hidden="true"><i></i><i></i><i></i></span>
    </div>
    <p class="talk-status" aria-live="polite">${sub}</p>`;
  foot.querySelector('#liveBtn').addEventListener('click', () => {
    if (liveStatus === 'live') pauseLive();
    else if (liveStatus !== 'connecting') { lastError = null; drawMessages(); connectLive(); }
  });
}

function setStatus(s) {
  status = s;
  drawFooter();
  drawPreview();
  if (s === 'thinking' || s === 'idle') drawMessages();
}

// ======================================================================
// Yardımlar: öğretmen cümlesi çevirisi ve "Nasıl denir?"
// ======================================================================
async function toggleTranslate(id) {
  const m = lesson.messages.find((x) => x.id === id);
  if (!m || !m.text || m.trLoading) return;
  // Çeviri varsa sadece göster/gizle (tekrar ücret yok)
  if (m.tr) { m.trHidden = !m.trHidden; drawMessages(); saveLesson(); return; }
  if (!ctx.state.settings.apiKey) return;
  m.trLoading = true;
  drawMessages();
  try {
    const r = await chatJSON(ctx.state.settings, [
      { role: 'system', content: 'Translate the English text into natural, simple Turkish. Return ONLY JSON: {"tr": "..."}' },
      { role: 'user', content: m.say ? m.say + '\n\n' + m.text : m.text },
    ], 400, ctx.state.settings.models.analysis);
    await addLessonCost(r.cost);
    m.tr = String(r.data.tr || '');
  } catch (e) {
    ctx.toast(e.message);
  }
  delete m.trLoading;
  await saveLesson();
  if (ctx.app.querySelector('#msgs')) drawMessages();
}

let howSayState = null; // { tr, result, busy }

function setLiveMic(enabled) {
  if (mode === 'live' && stream) stream.getAudioTracks().forEach((t) => { t.enabled = enabled; });
}

function openHowSay() {
  howSayState = { tr: '', result: null, busy: '' };
  setLiveMic(false); // Canlı Sohbet'te öğretmen Türkçe konuşmanı duymasın
  if (mode === 'ptt' && status === 'speaking') { stopAudio(); setStatus('idle'); }
  drawSheet();
}

function closeHowSay() {
  howSayState = null;
  stopPlayback();
  setLiveMic(true);
  drawSheet();
}

function drawSheet() {
  const box = ctx.app.querySelector('#sheet');
  if (!box) return;
  if (!howSayState) { box.innerHTML = ''; return; }
  const { esc } = ctx;
  const h = howSayState;
  const r = h.result;
  box.innerHTML = `
    <div class="sheet-backdrop" id="sheetClose"></div>
    <section class="sheet" role="dialog" aria-label="Nasıl denir?">
      <div class="row-between"><h2>Nasıl denir?</h2><button type="button" class="icon-btn" id="sheetX" aria-label="Kapat">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <p class="small">Söylemek istediğini Türkçe yaz ya da söyle; İngilizcesini öğreteyim.</p>
      <label for="trInput" class="sr-only">Türkçe cümle</label>
      <textarea id="trInput" class="textarea" rows="2" placeholder="Örn: Dün işten geç çıktım">${esc(h.tr)}</textarea>
      <button type="button" class="btn hold-btn" id="trMic">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
        <span>${h.busy === 'stt' ? 'Yazıya çeviriyorum…' : 'Basılı tut, Türkçe söyle'}</span>
      </button>
      <button type="button" class="btn btn-small btn-primary" id="trGo" ${h.busy ? 'disabled' : ''}>${h.busy === 'tr' ? 'Hazırlanıyor…' : 'Yazdığımın İngilizcesi'}</button>
      ${r ? `<div class="how-result">
        <div class="row" style="align-items:flex-start; gap:8px">
          <p class="how-en" style="flex:1">${esc(r.en)}</p>
          <button type="button" class="replay" id="howListen" aria-label="Dinle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button>
        </div>
        ${r.alt ? `<p class="small">Başka bir şekilde: <b style="color:var(--text)">${esc(r.alt)}</b></p>` : ''}
        ${r.note ? `<p class="small" style="color:#E5C88E">${esc(r.note)}</p>` : ''}
        <button type="button" class="btn btn-send" id="howTry">${mode === 'live' ? 'Kapat ve öğretmene söyle' : 'Kapat ve şimdi söyle'}</button>
      </div>` : ''}
    </section>`;

  const input = box.querySelector('#trInput');
  input.addEventListener('input', () => { h.tr = input.value; });
  box.querySelector('#sheetClose').addEventListener('click', closeHowSay);
  box.querySelector('#sheetX').addEventListener('click', closeHowSay);
  box.querySelector('#trGo').addEventListener('click', () => translateToEnglish());
  box.querySelector('#howListen')?.addEventListener('click', async () => {
    try { await playText(ctx.state.settings, ctx.state.profile.level, r.en); } catch (e) { ctx.toast(e.message); }
  });
  box.querySelector('#howTry')?.addEventListener('click', closeHowSay);
  holdToRecord(box.querySelector('#trMic'), {
    canStart: () => !h.busy && !!ctx.state.settings.apiKey,
    onStart: () => {
      h.busy = 'rec';
      const b = box.querySelector('#trMic');
      b.classList.add('rec');
      b.querySelector('span').textContent = 'Dinliyorum… bitince bırak';
    },
    onStop: async (blob, seconds) => {
      h.busy = 'stt';
      const b = box.querySelector('#trMic');
      b.classList.remove('rec');
      b.querySelector('span').textContent = 'Yazıya çeviriyorum…';
      try {
        const t = await transcribeDetailed(ctx.state.settings, blob, { language: 'tr', logprobs: false });
        await addLessonCost(transcribeCost(seconds, ctx.state.settings));
        h.tr = t.text;
        h.busy = '';
        if (h.tr) { await translateToEnglish(); return; }
      } catch (e) { ctx.toast(e.message); }
      h.busy = '';
      if (howSayState === h) drawSheet();
    },
    onError: (m) => { h.busy = ''; ctx.toast(m); if (howSayState === h) drawSheet(); },
  });
}

async function translateToEnglish() {
  const h = howSayState;
  if (!h) return;
  const text = (h.tr || '').trim();
  if (!text) { ctx.toast('Önce Türkçe bir cümle yaz ya da söyle.'); return; }
  if (!ctx.state.settings.apiKey) { ctx.toast('Önce Ayarlar’dan API anahtarını gir.'); return; }
  h.busy = 'tr';
  drawSheet();
  try {
    const lastTeacher = [...lesson.messages].reverse().find((m) => m.role === 'teacher')?.text || '';
    const r = await chatJSON(ctx.state.settings, [
      { role: 'system', content: `You help an adult Turkish learner (English level ${ctx.state.profile.level}) say something in English during a conversation lesson. Give the most natural spoken English for the Turkish text, using vocabulary suitable for the level. Return ONLY JSON: {"en": "natural English sentence", "alt": "another common way to say it (optional, may be empty)", "note_tr": "very short Turkish note about a key word or structure (max 15 words)"}` },
      { role: 'user', content: (lastTeacher ? `Context – the teacher just said: "${lastTeacher}"
` : '') + `Turkish: ${text}` },
    ], 500, ctx.state.settings.models.analysis);
    await addLessonCost(r.cost);
    h.result = { en: String(r.data.en || ''), alt: String(r.data.alt || ''), note: String(r.data.note_tr || '') };
  } catch (e) {
    ctx.toast(e.message);
  }
  h.busy = '';
  if (howSayState === h) {
    drawSheet();
    if (h.result && h.result.en) {
      try { await playText(ctx.state.settings, ctx.state.profile.level, h.result.en); } catch { /* ses olmasa da metin yeterli */ }
    }
  }
}

// ======================================================================
// Bas-Konuş
// ======================================================================
async function openMic() {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    drawFooter();
    return true;
  } catch {
    ctx.toast('Mikrofona erişilemedi. Tarayıcı izinlerini kontrol et.');
    drawFooter();
    return false;
  }
}

async function onPress(e) {
  e.preventDefault();
  // Öğretmen konuşurken basılırsa: sesi kes ve hemen kayda başla
  if (status === 'speaking') stopAudio();
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
  if (!ctx || mode !== 'ptt' || !lesson || !ctx.app.querySelector('#talk')) return;
  const seconds = (performance.now() - recStart) / 1000;
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  if (seconds < 0.6 || blob.size < 1000) {
    ctx.toast('Çok kısa oldu. Düğmeyi basılı tutarak konuş.');
    setStatus(pending ? 'preview' : 'idle');
    return;
  }
  setStatus('transcribing');
  const { settings } = ctx.state;
  try {
    const targets = allTargets();
    const hint = 'An English learner speaking English.' + (targets.length ? ' Words: ' + targets.join(', ') + '.' : '');
    const r = await transcribeDetailed(settings, blob, { hint });
    await addLessonCost(transcribeCost(seconds, settings));
    if (!r.text) {
      ctx.toast('Ses anlaşılamadı, tekrar dene.');
      setStatus('idle');
      return;
    }
    const unsure = uncertainWords(r.words);
    pending = { text: r.text, words: r.words, unsure };
    if (unsure.length) addPronWords(unsure.map((u) => u.w));
    setStatus('preview');
  } catch (err) {
    ctx.toast(err.message);
    setStatus('idle');
  }
}

async function sendPending() {
  if (!pending) return;
  const msg = { id: Date.now(), role: 'student', text: pending.text };
  pending = null;
  const prevTeacher = [...lesson.messages].reverse().find((m) => m.role === 'teacher')?.text;
  lesson.messages.push(msg);
  await countSentence();
  runAnalysis(msg, prevTeacher);
  await saveLesson();
  teacherTurn();
}

async function teacherSystem(live) {
  const { state } = ctx;
  const bank = await loadMistakes();
  const focus = (lesson.focusMistakes || []).map((id) => bank.find((m) => m.id === id)).filter((m) => m && m.status === 'active');
  let sys = buildTeacherSystem(state, { focus, review: lesson.reviewWords || [], live });
  if (live) {
    sys += '\n\n' + liveSpeechStyle(state.settings, state.profile.level);
    if (lesson.messages.length) {
      const recent = lesson.messages.filter((m) => m.text && !m.pending).slice(-12)
        .map((m) => (m.role === 'teacher' ? 'Teacher: ' + (m.say ? m.say + ' ' : '') : 'Student: ') + m.text).join('\n');
      sys += `\n\nCONVERSATION SO FAR (the lesson was paused; continue from here, do not start a new lesson):\n${recent}`;
    }
  }
  return sys;
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
  const myLesson = lesson;

  const history = lesson.messages.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role === 'teacher' ? 'assistant' : 'user',
    content: m.role === 'teacher' && m.say ? m.say + '\n\n' + m.text : m.text,
  }));
  if (!lesson.messages.length) history.push({ role: 'user', content: '[START_LESSON]' });
  const notice = state.profile.levelNotice;
  const messages = [{ role: 'system', content: await teacherSystem(false) }, ...history];

  let data;
  try {
    const r = await chatJSON(state.settings, messages);
    data = r.data;
    await addLessonCost(r.cost);
  } catch (err) {
    if (myLesson !== lesson) return;
    lastError = err.message;
    setStatus('idle');
    return;
  }
  if (!ctx || mode !== 'ptt' || myLesson !== lesson) return;

  const reply = String(data.reply || '').trim() || 'Sorry, could you say that again?';
  let corrSay = String(data.correction_say || '').trim();
  // Düzeltme ayarı "önemliler" ise küçük hatalar sesli söylenmez
  if (corrSay && state.settings.correction === 'important' && data.correction && data.correction.important === false) corrSay = '';
  const last = lesson.messages[lesson.messages.length - 1];
  if (last && last.role === 'student' && data.correction && data.correction.corrected) {
    last.correction = data.correction;
  }
  if (notice && state.profile.levelNotice === notice) {
    delete state.profile.levelNotice;
    await saveProfile(state.profile);
  }
  applyWords(data.words_used_ok || [], data.words_used_wrong || []);

  const tmsg = { id: Date.now(), role: 'teacher', text: reply };
  if (corrSay) tmsg.say = corrSay;
  lesson.messages.push(tmsg);
  await saveLesson();
  if (!ctx.app.querySelector('#msgs')) return; // kullanıcı ekrandan çıktı
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
      const spoken = msg.say ? msg.say + ' ... ' + msg.text : msg.text;
      const blob = await speak(state.settings, spoken, ttsInstructions(state.settings, state.profile.level));
      url = URL.createObjectURL(blob);
      audioUrls.set(msg.id, url);
      const probe = new Audio(url);
      probe.addEventListener('loadedmetadata', () => {
        if (isFinite(probe.duration)) addLessonCost(ttsCost(probe.duration));
      });
    }
    if (!ctx || mode !== 'ptt' || status !== 'speaking' || !ctx.app.querySelector('#talk')) return;
    audio = new Audio(url);
    audio.preservesPitch = true;
    audio.playbackRate = playbackRate(state.settings, state.profile.level);
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

// ======================================================================
// Canlı Sohbet
// ======================================================================
async function connectLive() {
  const { state } = ctx;
  if (rt || liveStatus === 'connecting') return;
  liveStatus = 'connecting';
  drawFooter();
  drawMessages();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    liveStatus = 'error';
    lastError = 'Mikrofona erişilemedi. Tarayıcı izinlerini kontrol et.';
    drawFooter();
    drawMessages();
    return;
  }
  const s = state.settings;
  const model = s.modelSize === 'large' ? s.models.realtimeLarge : s.models.realtimeMini;
  const resuming = lesson.messages.length > 0;
  const myLesson = lesson;
  try {
    const conn = await connectRealtime({
      apiKey: s.apiKey,
      model,
      instructions: await teacherSystem(true),
      voice: s.voice,
      speed: realtimeSpeed(s, state.profile.level),
      transcribeModel: transcribeModel(s),
      stream,
      handlers: liveHandlers({ resuming }),
    });
    if (!ctx || mode !== 'live' || liveStatus !== 'connecting' || myLesson !== lesson) { conn.close(); return; }
    rt = conn;
    if (pendingOpen) { const f = pendingOpen; pendingOpen = null; f(); }
  } catch (err) {
    stopStream();
    rt = null;
    if (myLesson !== lesson) return;
    liveStatus = 'error';
    lastError = err.message;
    drawFooter();
    drawMessages();
  }
}

let pendingOpen = null;
let lastWarnAt = 0;

function liveHandlers({ resuming }) {
  const myLesson = lesson;
  const alive = () => ctx && lesson && lesson === myLesson && mode === 'live';
  return {
    onOpen() {
      const start = () => {
        if (!alive()) return;
        liveStatus = 'live';
        drawFooter();
        drawMessages();
        if (!resuming) rt.respond();
        else rt.respond('The student has just come back after a pause. Say "Welcome back!" in a few words and continue the conversation with a question related to where you left off.');
      };
      if (rt) start(); else pendingOpen = start;
    },
    onListening(b) { if (!alive()) return; listening = b; drawFooter(); },
    onSpeaking(b) { if (!alive()) return; speaking = b; drawFooter(); },
    onUserItem(itemId) {
      if (!alive() || lesson.messages.some((m) => m.itemId === itemId)) return;
      lesson.messages.push({ id: Date.now(), itemId, role: 'student', text: '', pending: true });
      scheduleDraw();
    },
    async onUserTranscript(itemId, text) {
      if (!alive()) return;
      let msg = lesson.messages.find((m) => m.itemId === itemId);
      if (!text) {
        if (msg) lesson.messages.splice(lesson.messages.indexOf(msg), 1);
        scheduleDraw();
        return;
      }
      if (!msg) {
        msg = { id: Date.now(), itemId, role: 'student', text };
        lesson.messages.push(msg);
      }
      msg.text = text;
      delete msg.pending;
      const idx = lesson.messages.indexOf(msg);
      const prevTeacher = lesson.messages.slice(0, idx).reverse().find((m) => m.role === 'teacher')?.text;
      await countSentence();
      runAnalysis(msg, prevTeacher);
      await saveLesson();
      scheduleDraw();
    },
    onAssistantDelta(rid, delta) {
      if (!alive()) return;
      let msg = lesson.messages.find((m) => m.respId === rid);
      if (!msg) {
        msg = { id: Date.now() + Math.random(), respId: rid, role: 'teacher', text: '' };
        lesson.messages.push(msg);
      }
      msg.text += delta;
      scheduleDraw();
    },
    async onAssistantDone(rid, text) {
      if (!alive()) return;
      let msg = lesson.messages.find((m) => m.respId === rid);
      if (!msg) {
        msg = { id: Date.now() + Math.random(), respId: rid, role: 'teacher', text: '' };
        lesson.messages.push(msg);
      }
      if (text) msg.text = text;
      if (noticeSent && ctx.state.profile.levelNotice === noticeSent) {
        delete ctx.state.profile.levelNotice;
        noticeSent = null;
        await saveProfile(ctx.state.profile);
      }
      await saveLesson();
      scheduleDraw();
    },
    onUsage(usd) { addLessonCost(usd); },
    onWarn(m) {
      if (!alive()) return;
      const now = Date.now();
      if (now - lastWarnAt > 8000) { lastWarnAt = now; ctx.toast('Uyarı: ' + String(m).slice(0, 120)); }
    },
    onError(m) {
      if (!alive()) return;
      lastError = m;
      pauseLive('error');
    },
  };
}

function closeLive() {
  if (rt) { rt.close(); rt = null; }
  pendingOpen = null;
  speaking = false;
  listening = false;
}

function pauseLive(st = 'paused') {
  closeLive();
  stopStream();
  liveStatus = st;
  lesson.messages = lesson.messages.filter((m) => !m.pending);
  saveLesson();
  drawFooter();
  drawMessages();
}

// ======================================================================
// Ortak: analiz, kelimeler, kayıt
// ======================================================================
async function countSentence() {
  ctx.state.profile.sentenceCount = (ctx.state.profile.sentenceCount || 0) + 1;
  await saveProfile(ctx.state.profile);
}

function runAnalysis(msg, prevTeacher) {
  if (!ctx.state.settings.apiKey) return;
  const lessonRef = lesson;
  analyzeSentence(ctx.state, { text: msg.text, prevTeacher, lessonId: lesson.id, targets: allTargets() }, (r) => onAnalysis(lessonRef, msg.id, r));
}

function applyWords(okList, badList, ref = lesson) {
  const targets = new Set([...ctx.state.study.words, ...(ref.reviewWords || [])].map((w) => w.toLowerCase()));
  const okW = [];
  const badW = [];
  okList.forEach((w) => {
    const k = String(w).toLowerCase();
    if (targets.has(k)) { ref.wordStatus[k] = 'ok'; okW.push(k); }
  });
  badList.forEach((w) => {
    const k = String(w).toLowerCase();
    if (targets.has(k)) { badW.push(k); if (ref.wordStatus[k] !== 'ok') ref.wordStatus[k] = 'bad'; }
  });
  recordWordUse(okW, badW);
}

async function onAnalysis(lessonRef, msgId, r) {
  if (!r) return;
  // Ders bu arada bittiyse, sonuçları arşivdeki derse yaz
  const target = lessonRef;
  const msg = target.messages.find((m) => m.id === msgId);
  const liveLesson = mode === 'live' || target.mode === 'live';
  if (msg) {
    msg.scores = r.scores;
    if (liveLesson && r.mistake && !msg.correction) {
      msg.correction = { original: r.mistake.original, corrected: r.mistake.corrected, note_tr: r.mistake.rule_tr, important: true };
    }
  }
  if (liveLesson) applyWords(r.wordsOk, r.wordsBad, target);
  target.mistakesAdded = [...(target.mistakesAdded || []), ...r.added.map((m) => m.id)];
  target.mistakesLearned = [...(target.mistakesLearned || []), ...r.learned.map((m) => m.id)];

  if (target !== lesson) {
    // Arşivlenmiş dersi güncelle
    const archive = (await db.get('lessons')) || [];
    const i = archive.findIndex((l) => l.id === target.id);
    if (i >= 0) {
      archive[i] = { ...archive[i], messages: target.messages, wordStatus: target.wordStatus, mistakesAdded: target.mistakesAdded, mistakesLearned: target.mistakesLearned };
      await db.set('lessons', archive);
    }
    return;
  }
  await saveLesson();
  if (!ctx || !ctx.app.querySelector('#msgs')) return;
  drawMessages();
  drawChips();

  if (r.levelChange) {
    const up = LEVELS.indexOf(r.levelChange.to) > LEVELS.indexOf(r.levelChange.from);
    ctx.toast((up ? 'Seviye atladın: ' : 'Seviye ayarlandı: ') + r.levelChange.from + ' → ' + r.levelChange.to);
    const pill = ctx.app.querySelector('.lvl-pill');
    if (pill) pill.textContent = r.levelChange.to;
    if (mode === 'live' && rt) {
      noticeSent = ctx.state.profile.levelNotice;
      rt.updateInstructions(await teacherSystem(true));
    }
  } else if (r.learned.length) {
    ctx.toast('Öğrenildi: ' + r.learned[0].corrected);
  }
}

async function saveLesson() {
  if (lesson) {
    lesson.mode = mode;
    await db.set('lesson', JSON.parse(JSON.stringify(lesson, (k, v) => (k === 'trLoading' ? undefined : v))));
  }
}

async function addLessonCost(usd) {
  if (!usd || !lesson) return;
  lesson.cost = (lesson.cost || 0) + usd;
  await addCost(usd);
  await saveLesson();
}

// Dersi arşivle (özet ekranı ve İlerleme için)
export async function archiveLesson(l, levelEnd) {
  const archive = (await db.get('lessons')) || [];
  l.messages = l.messages.filter((m) => !m.pending);
  l.endedAt = new Date().toISOString();
  l.levelEnd = levelEnd;
  archive.unshift(l);
  await db.set('lessons', archive.slice(0, 40));
  await db.del('lesson');
  return l;
}

async function endLesson() {
  if (status === 'thinking' || status === 'transcribing') return;
  const hasStudent = lesson.messages.some((m) => m.role === 'student' && !m.pending);
  if (!hasStudent) {
    if (!confirm('Bu derste henüz konuşmadın. Ders sıfırlanıp yeniden başlasın mı?')) return;
    leaveLesson();
    await db.del('lesson');
    renderLesson(ctx);
    return;
  }
  if (!confirm('Dersi bitirip özetini görmek ister misin?')) return;
  leaveLesson();
  audioUrls.forEach((u) => URL.revokeObjectURL(u));
  audioUrls.clear();
  const done = await archiveLesson(lesson, ctx.state.profile.level);
  lesson = null;
  location.hash = '#summary/' + done.id;
}

// Ayarlardaki "Sesi dinle" düğmesi için
export async function previewVoice(settings, level) {
  const blob = await speak(settings, "Hello! I'm your English teacher. Let's practise speaking together.", ttsInstructions(settings, level));
  const a = new Audio(URL.createObjectURL(blob));
  a.preservesPitch = true;
  a.playbackRate = playbackRate(settings, level);
  await a.play();
  await addCost(ttsCost(4));
}

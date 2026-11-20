// Telaffuz Çalışması
// Kelime/cümle seç → öğretmenden dinle → basılı tutup söyle → sesli girdi modeli değerlendirir

import { db, addCost } from './db.js';
import { assessPronunciation, transcribeDetailed, transcribeCost } from './openai.js';
import { playText, toWavBase64, holdToRecord, stopPlayback } from './audio.js';
import { loadMistakes } from './analysis.js';

// ---------- Zorlandığın kelimeler listesi ----------
export const loadPronWords = async () => (await db.get('pronWords')) || {};
const savePronWords = (w) => db.set('pronWords', w);

export async function addPronWords(words) {
  if (!words.length) return;
  const all = await loadPronWords();
  const now = new Date().toISOString();
  words.forEach((w) => {
    const k = w.toLowerCase().replace(/[’]/g, "'");
    const v = all[k] || (all[k] = { count: 0, best: null, addedAt: now });
    v.count++;
    v.lastAt = now;
  });
  await savePronWords(all);
}

async function recordScore(target, score) {
  const all = await loadPronWords();
  const k = target.toLowerCase().trim();
  if (!all[k]) return;
  all[k].best = Math.max(all[k].best ?? 0, score);
  all[k].tries = (all[k].tries || 0) + 1;
  await savePronWords(all);
}

// ---------- Ekran ----------
let target = '';
let result = null;
let busy = '';

export async function renderPron(c, sub) {
  const { app, state, esc, toast } = c;
  if (sub) { target = decodeURIComponent(sub); result = null; }
  const pw = await loadPronWords();
  const hard = Object.entries(pw).sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  const today = state.study.words;
  const mistakes = (await loadMistakes()).filter((m) => m.status === 'active' && m.corrected && m.corrected.split(' ').length <= 8).slice(0, 6);

  const chip = (t, extra = '') => `<button type="button" class="chip chip-btn" data-pick="${esc(t)}">${esc(t)}${extra}</button>`;

  app.innerHTML = `
  <div class="page">
    <div style="display:flex; flex-direction:column; gap:4px">
      <h1>Telaffuz Çalışması</h1>
      <p class="muted">Bir kelime veya cümle seç, önce dinle, sonra basılı tutup söyle.</p>
    </div>

    <section class="card">
      <label for="pronInput" style="font-size:15px; font-weight:700">Ne çalışmak istersin?</label>
      <div class="row">
        <input id="pronInput" class="input" style="flex:1; min-width:0" placeholder="Kelime veya kısa cümle yaz" value="${esc(target)}" autocapitalize="none" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-small" id="pronSet">Seç</button>
      </div>
      ${hard.length ? `<p class="small" style="font-weight:600">Zorlandığın kelimeler</p>
        <div class="chip-row" style="max-height:none">${hard.map(([w, v]) => chip(w, v.best != null ? ` <span class="best ${v.best >= 85 ? 'good' : ''}">${v.best}</span>` : '')).join('')}</div>` : ''}
      ${today.length ? `<p class="small" style="font-weight:600">Günün kelimeleri</p>
        <div class="chip-row" style="max-height:none">${today.map((w) => chip(w)).join('')}</div>` : ''}
      ${mistakes.length ? `<p class="small" style="font-weight:600">Düzeltilen ifadelerin</p>
        <div class="chip-row" style="max-height:none">${mistakes.map((m) => chip(m.corrected)).join('')}</div>` : ''}
      ${!hard.length && !today.length && !mistakes.length ? '<p class="small">Derslerde net anlaşılmayan kelimelerin burada birikecek. Şimdilik istediğin bir kelimeyi yazabilirsin.</p>' : ''}
    </section>

    ${target ? `
    <section class="card pron-card">
      <p class="small" style="font-weight:600">Söyle:</p>
      <p class="pron-target">${esc(target)}</p>
      <div class="row">
        <button type="button" class="btn btn-small" style="flex:1" data-listen="slow">Yavaş dinle</button>
        <button type="button" class="btn btn-small" style="flex:1" data-listen="normal">Normal dinle</button>
      </div>
      <button type="button" class="talk" id="pronTalk" ${busy ? 'disabled' : ''}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
        <span>${busy || 'Basılı tut ve söyle'}</span>
      </button>
    </section>` : ''}

    <div id="pronResult"></div>
  </div>`;

  drawResult(c);

  app.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    target = b.dataset.pick;
    result = null;
    renderPron(c);
    setTimeout(() => app.querySelector('.pron-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }));
  const setFromInput = () => {
    const v = app.querySelector('#pronInput').value.trim().replace(/\s+/g, ' ');
    if (!v) { toast('Önce bir kelime veya cümle yaz.'); return; }
    if (v.split(' ').length > 15) { toast('Kısa tut: en fazla 15 kelime.'); return; }
    target = v;
    result = null;
    renderPron(c);
  };
  app.querySelector('#pronSet').addEventListener('click', setFromInput);
  app.querySelector('#pronInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') setFromInput(); });

  app.querySelectorAll('[data-listen]').forEach((b) => b.addEventListener('click', async () => {
    if (!state.settings.apiKey) { toast('Önce Ayarlar’dan API anahtarını gir.'); return; }
    b.disabled = true;
    try { await playText(state.settings, state.profile.level, target, b.dataset.listen); }
    catch (e) { toast(e.message); }
    b.disabled = false;
  }));

  const talk = app.querySelector('#pronTalk');
  if (talk) {
    holdToRecord(talk, {
      canStart: () => !busy && !!state.settings.apiKey,
      onStart: () => {
        stopPlayback();
        talk.classList.add('talk-rec');
        talk.querySelector('span').textContent = 'Dinliyorum… bitince bırak';
      },
      onStop: (blob, seconds) => evaluate(c, blob, seconds),
      onError: (m) => {
        talk.classList.remove('talk-rec');
        talk.querySelector('span').textContent = 'Basılı tut ve söyle';
        toast(m);
      },
    });
    talk.addEventListener('click', () => { if (!state.settings.apiKey) toast('Önce Ayarlar’dan API anahtarını gir.'); });
  }
}

async function evaluate(c, blob, seconds) {
  const { state, toast } = c;
  const myTarget = target;
  busy = 'Değerlendiriliyor…';
  renderPron(c);
  try {
    const [assess, heard] = await Promise.all([
      toWavBase64(blob).then((w) => assessPronunciation(state.settings, w.b64, myTarget, state.profile.level)),
      // İpucu vermeden yazıya çevir: gerçekte ne anlaşıldığını görmek için
      transcribeDetailed(state.settings, blob, { logprobs: false }).catch(() => ({ text: '' })),
    ]);
    await addCost(assess.cost + transcribeCost(seconds, state.settings));
    const d = assess.data || {};
    const score = Math.max(0, Math.min(100, Math.round(+d.score || 0)));
    result = { target: myTarget, score, heard: heard.text, summary: d.summary_tr || '', words: Array.isArray(d.words) ? d.words : [] };
    await recordScore(myTarget, score);
  } catch (e) {
    toast(e.message);
  }
  busy = '';
  if (location.hash.startsWith('#pron')) {
    await renderPron(c);
    c.app.querySelector('#pronResult')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function drawResult(c) {
  const { app, state, esc, toast } = c;
  const box = app.querySelector('#pronResult');
  if (!box || !result || result.target !== target) return;
  const r = result;
  const color = r.score >= 85 ? 'var(--green)' : r.score >= 60 ? 'var(--amber)' : 'var(--danger)';
  const label = r.score >= 85 ? 'Çok iyi!' : r.score >= 60 ? 'Fena değil, biraz daha' : 'Tekrar deneyelim';
  const bad = r.words.filter((w) => w && w.ok === false);
  box.innerHTML = `
    <section class="card">
      <div class="row" style="gap:14px">
        <div class="score-ring" style="border-color:${color}"><b>${r.score}</b></div>
        <div style="flex:1; display:flex; flex-direction:column; gap:4px">
          <span style="font-size:16px; font-weight:800; color:${color}">${label}</span>
          ${r.summary ? `<span style="font-size:14px; line-height:1.5; color:var(--soft)">${esc(r.summary)}</span>` : ''}
        </div>
      </div>
      ${r.heard ? `<p class="small">Uygulamanın duyduğu: <b style="color:var(--text)">${esc(r.heard)}</b></p>` : ''}
      ${r.words.length ? `<div class="chip-row" style="max-height:none">${r.words.map((w) => `<span class="chip ${w.ok === false ? 'chip-bad' : 'chip-ok'}">${esc(w.word || '')}</span>`).join('')}</div>` : ''}
    </section>
    ${bad.map((w, i) => `
      <section class="card" style="gap:8px">
        <div class="row-between">
          <span style="font-size:17px; font-weight:800">${esc(w.word || '')}</span>
          <button type="button" class="btn btn-small" data-wslow="${i}" style="min-height:38px">Yavaş dinle</button>
        </div>
        ${w.issue_tr ? `<p style="font-size:14px; line-height:1.5"><span class="ml-label" style="display:inline; color:var(--amber)">Sorun: </span>${esc(w.issue_tr)}</p>` : ''}
        ${w.tip_tr ? `<p style="font-size:14px; line-height:1.5"><span class="ml-label" style="display:inline">Nasıl: </span>${esc(w.tip_tr)}</p>` : ''}
        ${w.say_like ? `<p class="ml-pattern" style="font-size:15px">Şöyle oku: ${esc(w.say_like)}</p>` : ''}
      </section>`).join('')}
    <p class="small" style="text-align:center">Puan yapay zekâ tahminidir; belirgin hataları yakalar ama ses ölçen özel programlar kadar hassas değildir.</p>`;
  box.querySelectorAll('[data-wslow]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await playText(state.settings, state.profile.level, bad[+b.dataset.wslow].word, 'slow'); }
    catch (e) { toast(e.message); }
    b.disabled = false;
  }));
}

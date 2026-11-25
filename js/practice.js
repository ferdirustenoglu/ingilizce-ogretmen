// Alıştırma: oturum yönetimi, yazma ekranı, sonuç ekranı, oturum özeti.
// Rotalar: #calis · #ozet

import { db, loadSettings } from './db.js';
import { speak, stopAudio, hasKey, canSpeak, transcribe } from './ai.js';
import { PATTERNS, UNITS, patternById, patternsOfUnit, LEVELS } from './curriculum.js';
import { mistakeLabel } from './rules.js';
import {
  generateItems, checkAnswer, loadProfile, saveProfile, levelFor,
  updateMastery, loadMastery, masteryOf, setLearned,
  addReview, reviewDone, loadReviews, dueReviews,
  recordMistake, loadMistakes, recordAnswer, markBad, loadStats, ROLE_LABELS,
} from './learn.js';
import { esc, toast, IC, header, patternChips, blocks, highlight, bar } from './ui.js';

const LEARN_FORMS = [
  'short positive sentence',
  'positive sentence',
  'negative sentence',
  'question',
  'negative sentence or question (choose the more natural one)',
  'positive sentence with a bit more detail',
  'longer sentence that also uses a pattern from an earlier unit',
  'free: the most natural daily-life use of the pattern',
];
const PLACEMENT = ['u1-simple', 'u2-past', 'u3-goingto', 'u4-perfect', 'u5-should', 'u6-comp', 'u7-ing', 'u8-if1', 'u9-passive', 'gk-used'];

// ---------- Oturum: bellekte tek kaynak + sıralı kayıt ----------
let cur = null;
let chain = Promise.resolve();
let genPromise = null;

export async function getSession() {
  if (!cur) cur = (await db.get('session')) || null;
  return cur;
}
function persist() {
  if (!cur) return chain;
  const snap = JSON.parse(JSON.stringify(cur));
  chain = chain.then(() => db.set('session', snap)).catch(() => {});
  return chain;
}
export function resetPracticeCache() { cur = null; genPromise = null; }
export function stopRecording() {
  if (recState) { try { recState.rec.stop(); } catch { /* yok */ } recState.stream.getTracks().forEach((t) => t.stop()); recState = null; }
}

/**
 * Yeni oturum başlat.
 * mode: 'learn' (pid) · 'review' · 'mistake' (type) · 'placement' · 'retry' (items)
 */
export async function startSession(ctx, opts) {
  const settings = ctx.state.settings;
  if (opts.mode !== 'retry' && opts.mode !== 'review' && !hasKey(settings)) {
    toast('Önce Ayarlar’dan API anahtarını gir.');
    location.hash = '#ayarlar';
    return;
  }
  const s = {
    id: 's' + Date.now().toString(36),
    mode: opts.mode, pid: opts.pid || null, mtype: opts.type || null,
    specs: [], items: [], idx: 0, startedAt: new Date().toISOString(), done: false,
  };
  if (opts.mode === 'learn') {
    s.specs = LEARN_FORMS.slice(0, opts.n || 8).map((form) => ({ pid: opts.pid, form }));
    s.startScore = masteryOf(await loadMastery(), opts.pid).score;
  } else if (opts.mode === 'placement') {
    s.specs = PLACEMENT.map((pid) => ({ pid, form: 'typical everyday sentence, positive or question' }));
  } else if (opts.mode === 'mistake') {
    const all = await loadMistakes();
    const m = all[opts.type] || { examples: [], rules: [] };
    let pids = [...new Set(m.examples.map((e) => e.pid).filter((p) => patternById(p)))];
    if (!pids.length) pids = ['u1-article'];
    const focus = `${mistakeLabel(opts.type)} (${m.rules[0] || 'the learner keeps making this kind of mistake'})`;
    s.specs = Array.from({ length: 6 }, (_, i) => ({ pid: pids[i % pids.length], form: 'natural sentence', focus }));
  } else if (opts.mode === 'review') {
    const due = dueReviews(await loadReviews()).slice(0, 10);
    if (!due.length) { toast('Bugün tekrar edilecek cümle yok.'); return; }
    s.items = due.map((r) => freshItem({ ...r, id: r.rid }));
  } else if (opts.mode === 'retry') {
    s.items = opts.items.map((it) => freshItem(it));
  }
  s.target = s.specs.length || s.items.length;
  cur = s;
  genPromise = null;
  await persist();
  location.hash = '#calis';
}

const freshItem = (it) => ({ ...it, attempts: 0, hints: 0, draft: '', status: null, check: null, firstVerdict: null, tab: undefined });

// Yeterli cümle yoksa üret (ilk paket 3, sonrakiler 4 cümle)
function ensureItems(ctx, { force = false } = {}) {
  const s = cur;
  if (!s || genPromise) return genPromise || Promise.resolve();
  const missing = s.target - s.items.length;
  if (missing <= 0 || (!force && s.items.length - s.idx >= 2)) return Promise.resolve();
  const from = s.items.length;
  const specs = s.specs.slice(from, from + (from === 0 ? 3 : 4));
  genPromise = (async () => {
    const profile = await loadProfile();
    const stats = await loadStats();
    const level = s.mode === 'placement' ? 'A2' : levelFor(profile, specs[0].pid);
    const items = await generateItems(ctx.state.settings, {
      level, specs,
      avoid: [...(stats.recent || []), ...(stats.bad || []), ...s.items.map((x) => x.tr)],
    });
    if (!cur || cur.id !== s.id) return;
    s.items.push(...items.slice(0, s.target - s.items.length));
    await persist();
  })().finally(() => { genPromise = null; });
  return genPromise;
}

// ---------- Alıştırma ekranı ----------
export async function renderPractice(ctx) {
  const s = await getSession();
  if (!s) { location.hash = '#home'; return; }
  if (s.done) { location.hash = '#ozet'; return; }
  const item = s.items[s.idx];
  if (!item) {
    ctx.app.innerHTML = `
    <div class="page">
      ${header({ back: '#home', title: '<b>Cümle Atölyesi</b>' })}
      <div class="card center" id="load">
        <div class="dots"><span></span><span></span><span></span></div>
        <p>Cümleler hazırlanıyor…</p>
        <p class="small">Yapay zekâ cümleleri yazıp kontrol ediyor. 10–30 saniye sürebilir.</p>
      </div>
    </div>`;
    try {
      await ensureItems(ctx, { force: true });
      if (location.hash === '#calis') renderPractice(ctx);
    } catch (e) {
      const box = ctx.app.querySelector('#load');
      if (box) box.innerHTML = `<p class="err">${esc(e.message)}</p><button type="button" class="btn btn-primary" id="again">Tekrar dene</button>`;
      ctx.app.querySelector('#again')?.addEventListener('click', () => renderPractice(ctx));
    }
    return;
  }
  if (item.check) drawResult(ctx, s, item);
  else drawWrite(ctx, s, item);
  ensureItems(ctx).catch(() => {});
}

function topBar(s, item) {
  const p = patternById(item.pid);
  const title = s.mode === 'placement' ? '<b>Seviye testi</b>'
    : s.mode === 'review' ? '<b>Tekrar</b>'
      : s.mode === 'mistake' ? `<b>${esc(mistakeLabel(s.mtype))} çalışması</b>`
        : p ? patternChips(p) : '<b>Alıştırma</b>';
  const sub = `${p && s.mode !== 'placement' ? p.title + ' · ' : ''}Cümle ${s.idx + 1} / ${s.target}`;
  return header({ back: '#home', title, sub }) + bar((s.idx / s.target) * 100, 'thin');
}

const HINTS = ['Kural', 'Kelimeler', 'Baş harfler'];
const initials = (t) => t.split(/\s+/).map((w) => w.replace(/[A-Za-z]/g, (c, i) => (i === 0 ? c : '_'))).join(' ');

function hintPanel(item, i) {
  const p = patternById(item.pid);
  if (i === 0) {
    return `<div class="card hint">
      ${p ? `<p class="formula">${esc(p.formula)}</p>` : ''}
      ${item.rule ? `<p class="note">${esc(item.rule)}</p>` : ''}
      <span class="cap">İngilizce sıra</span>${blocks(item.parts, 'hint')}
      ${p ? `<a class="link" href="#kart/${p.id}">Kural kartını aç →</a>` : ''}
    </div>`;
  }
  if (i === 1) {
    return `<div class="card hint">${item.words.length
      ? `<div class="words">${item.words.map((w) => `<span><b>${esc(w.tr)}</b> → ${esc(w.en)}</span>`).join('')}</div>`
      : '<p class="note">Bu cümlede bilmen gereken özel bir kelime yok.</p>'}</div>`;
  }
  return `<div class="card hint">${blocks(item.parts.map((x) => ({ ...x, t: initials(x.t) })))}<p class="note">Her kelimenin ilk harfi. Gerisini sen tamamla.</p></div>`;
}

function drawWrite(ctx, s, item) {
  const tab = item.hints ? Math.min(item.tab ?? item.hints - 1, item.hints - 1) : -1;
  ctx.app.innerHTML = `
  <div class="page with-composer">
    ${topBar(s, item)}
    <section class="card tr-card">
      <span class="cap">Türkçe</span>
      <p class="tr-sentence">${highlight(item.tr, item.trFocus)}</p>
    </section>
    <div class="hint-tabs" role="group" aria-label="İpuçları">
      ${HINTS.map((h, i) => {
        const open = item.hints > i;
        const nextOne = item.hints === i;
        return `<button type="button" class="hint-btn${open ? ' open' : ''}${tab === i ? ' active' : ''}" data-hint="${i}" ${open || nextOne ? '' : 'disabled'}>${open || nextOne ? `<b>${i + 1}</b>` : IC.lock} ${h}</button>`;
      }).join('')}
    </div>
    ${tab >= 0 ? hintPanel(item, tab) : '<p class="small">Takılırsan ipuçlarını sırayla aç.</p>'}
    <button type="button" class="link-btn small-link" id="bad">${IC.flag} Bu Türkçe cümle hatalı / doğal değil</button>
  </div>
  <div class="composer">
    <p class="comp-tr" aria-hidden="true">${highlight(item.tr, item.trFocus)}</p>
    <div class="comp-row">
      <label class="sr-only" for="ans">İngilizcesini yaz</label>
      ${canSpeak(ctx.state.settings) && navigator.mediaDevices ? `<button type="button" class="mic" id="mic" aria-label="Sesle yaz">${IC.mic}</button>` : ''}
      <textarea id="ans" rows="2" autocomplete="off" autocapitalize="sentences" spellcheck="false" placeholder="İngilizcesini yaz ya da söyle…">${esc(item.draft || '')}</textarea>
      <button type="button" class="send" id="check" aria-label="Kontrol et">${IC.check}</button>
    </div>
    <div class="comp-foot"><span class="small">Enter: kontrol et</span><button type="button" class="link-btn" id="show">Cevabı göster</button></div>
  </div>`;

  const $ = (q) => ctx.app.querySelector(q);
  const ta = $('#ans');
  const btn = $('#check');
  const sync = () => { btn.disabled = !ta.value.trim(); };
  sync();
  let t;
  ta.addEventListener('input', () => { sync(); item.draft = ta.value; clearTimeout(t); t = setTimeout(persist, 500); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!btn.disabled) btn.click(); } });
  ctx.app.querySelectorAll('[data-hint]').forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.hint;
    if (item.hints <= i) item.hints = i + 1;
    item.tab = i;
    item.draft = ta.value;
    persist();
    const focused = document.activeElement === ta;
    drawWrite(ctx, s, item);
    if (focused) ctx.app.querySelector('#ans')?.focus();
  }));
  btn.addEventListener('click', () => { stopRecording(); submit(ctx, s, item, ta.value.trim()); });
  $('#show').addEventListener('click', () => reveal(ctx, s, item));
  $('#bad').addEventListener('click', () => reportBad(ctx, s, item));
  const mic = $('#mic');
  if (mic) setupMic(ctx, mic, ta, (text) => {
    // Söyleneni imlecin olduğu yere (yoksa sona) ekle
    const v = ta.value;
    const at = document.activeElement === ta ? ta.selectionStart : v.length;
    const before = v.slice(0, at);
    const after = v.slice(at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + pad + text + (after && !/^\s/.test(after) ? ' ' : '') + after;
    item.draft = ta.value;
    sync();
    persist();
    ta.focus();
    const pos = (before + pad + text).length;
    ta.setSelectionRange(pos, pos);
  });
}

// ---------- Sesli yazma: dokun → konuş → tekrar dokun ----------
let recState = null;
function setupMic(ctx, mic, ta, onText) {
  const composer = mic.closest('.composer');
  const setUi = (mode) => {
    mic.classList.toggle('rec', mode === 'rec');
    mic.classList.toggle('busy', mode === 'busy');
    composer.classList.toggle('listening', mode !== 'idle');
    mic.setAttribute('aria-label', mode === 'rec' ? 'Kaydı bitir' : 'Sesle yaz');
    ta.placeholder = mode === 'rec' ? 'Dinliyorum… bitince mikrofona tekrar dokun' : mode === 'busy' ? 'Yazıya çevriliyor…' : 'İngilizcesini yaz ya da söyle…';
  };
  const stop = () => { if (recState && recState.rec.state === 'recording') recState.rec.stop(); };
  mic.addEventListener('click', async () => {
    if (recState) { stop(); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Mikrofon izni verilmedi. Tarayıcı ayarlarından izin ver.');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    const started = Date.now();
    recState = { rec, stream };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearTimeout(recState.timer);
      stream.getTracks().forEach((tr) => tr.stop());
      const seconds = (Date.now() - started) / 1000;
      recState = null;
      if (seconds < 0.6) { setUi('idle'); toast('Çok kısa oldu. Dokun, konuş, sonra tekrar dokun.'); return; }
      setUi('busy');
      try {
        const text = await transcribe(ctx.state.settings, new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }), seconds);
        if (!document.body.contains(mic)) return; // ekran değiştiyse
        setUi('idle');
        if (text) onText(text); else toast('Ses anlaşılamadı, tekrar dene.');
      } catch (e) {
        setUi('idle');
        toast(e.message);
      }
    };
    rec.start();
    recState.timer = setTimeout(stop, 30000); // en fazla 30 saniye
    setUi('rec');
  });
}

async function reportBad(ctx, s, item) {
  if (!confirm('Bu cümle atılsın ve yerine yenisi gelsin mi?')) return;
  await markBad(item.tr);
  const i = s.items.indexOf(item);
  s.items.splice(i, 1);
  if (s.specs.length) {
    const [spec] = s.specs.splice(i, 1);
    s.specs.push(spec); // aynı türde yeni bir cümle sona eklenir
  } else {
    s.target--;
    if (s.mode === 'review') await reviewDone(item.id, true);
  }
  if (s.idx >= s.target) return finish(ctx, s);
  await persist();
  toast('Cümle atıldı.');
  renderPractice(ctx);
}

// İlk denemenin sonucunu kaydet (ustalık, tekrar, hata defteri, istatistik)
async function recordFirst(s, item, result, check, text) {
  await recordAnswer(result === 'first', item.tr);
  if (s.mode !== 'retry') await updateMastery(item.pid, result);
  if (s.mode === 'review') await reviewDone(item.id, result === 'first');
  else if (result !== 'first') await addReview(item);
  if (check && check.mistake) await recordMistake(check.mistake, item, text, check.fixed);
}

async function submit(ctx, s, item, text) {
  const btn = ctx.app.querySelector('#check');
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const profile = await loadProfile();
    const check = await checkAnswer(ctx.state.settings, levelFor(profile, item.pid), item, text);
    item.attempts++;
    item.draft = text;
    check.text = text;
    item.check = check;
    if (item.attempts === 1) {
      item.firstVerdict = check.verdict;
      const result = check.verdict === 'correct' ? (item.hints ? 'retry' : 'first') : check.verdict;
      item.status = result === 'first' ? 'first' : result === 'retry' ? 'retry' : 'missed';
      await recordFirst(s, item, result, check, text);
    } else if (check.verdict === 'correct' && item.status === 'missed') {
      item.status = 'fixed';
    }
    await persist();
    drawResult(ctx, s, item);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

async function reveal(ctx, s, item) {
  item.check = { verdict: 'shown', summary: '', praise: '', userParts: [], fixed: item.answer, fixedParts: item.parts, explain: [], also: null, text: '' };
  if (item.attempts === 0) {
    item.attempts = 1;
    item.firstVerdict = 'shown';
    item.status = 'missed';
    await recordFirst(s, item, 'shown', null, '');
  }
  await persist();
  drawResult(ctx, s, item);
}

const BANNERS = {
  correct: ['ok', 'Doğru!', 'Cümleyi doğru kurdun.'],
  close: ['close', 'Neredeyse oldu', 'Yapı doğru, küçük bir eksik var.'],
  wrong: ['bad', 'Tekrar bakalım', 'Cümlenin yapısında sorun var.'],
  shown: ['shown', 'Doğru cevap', 'İncele, bir sonrakinde sen dene.'],
};

function drawResult(ctx, s, item) {
  const c = item.check;
  const [cls, title, text] = BANNERS[c.verdict] || BANNERS.wrong;
  const isLast = s.idx + 1 >= s.target;
  const dailySame = c.fixed && item.daily && c.fixed.trim().toLowerCase() === item.daily.trim().toLowerCase();
  const speakOk = canSpeak(ctx.state.settings);
  const play = (what, label, slow = false) => (speakOk ? `<button type="button" class="pill" data-say="${what}" data-slow="${slow ? 1 : ''}">${IC.speaker} ${label}</button>` : '');

  ctx.app.innerHTML = `
  <div class="page with-footer">
    ${topBar(s, item)}
    <p class="tr-sentence sm">${highlight(item.tr, item.trFocus)}</p>
    <div class="banner ${cls}">
      <span class="bi">${c.verdict === 'correct' ? IC.check : '!'}</span>
      <span class="bt"><b>${title}</b><span>${esc(c.summary || text)}</span></span>
    </div>

    <section class="card">
      ${c.userParts.length ? `<span class="cap">Senin cevabın</span>${blocks(c.userParts, 'check')}` : ''}
      <span class="cap">Doğru hâli</span>
      ${blocks(c.fixedParts)}
      ${speakOk ? `<div class="row">${play('fixed', 'Dinle')}${play('fixed', 'Yavaş', true)}</div>` : ''}
    </section>

    ${c.praise ? `<p class="praise">${esc(c.praise)}</p>` : ''}

    ${c.explain.length ? `
    <section class="card">
      <span class="cap">Neden?</span>
      ${c.explain.map((e) => `<div class="why">
        <div class="row wrap">${e.type ? `<b class="why-t">${esc(mistakeLabel(e.type))}</b>` : ''}${e.tag ? `<span class="tag">${esc(e.tag)}</span>` : ''}</div>
        <p class="note">${esc(e.text)}</p>
        ${e.example ? `<p class="eg">${esc(e.example)}</p>` : ''}
      </div>`).join('')}
    </section>` : ''}

    ${item.steps.length ? `
    <details class="card steps-card" ${c.verdict === 'correct' ? '' : 'open'}>
      <summary><span class="cap">Adım adım çözüm ▾</span></summary>
      <div class="steps">${item.steps.map((st) => `<div class="step"><span class="blk r-${st.r} mini"><small>${esc(ROLE_LABELS[st.r] || '·')}</small></span><span><b>${esc(st.tr || '—')}</b> → <b class="en">${esc(st.en)}</b>${st.note ? `<br><span class="small">${esc(st.note)}</span>` : ''}</span></div>`).join('')}</div>
      ${item.rule ? `<p class="note">${esc(item.rule)}</p>` : ''}
    </details>` : ''}

    ${c.also ? `
    <section class="card green">
      <span class="cap">Bu da doğru</span>
      <p class="en-line">${esc(c.also.en)}</p>
      ${c.also.note ? `<p class="note">${esc(c.also.note)}</p>` : ''}
    </section>` : ''}

    <section class="card daily">
      <span class="cap row">${IC.chat} Günlük konuşmada böyle denir</span>
      <p class="en-line">${esc(item.daily)}</p>
      <p class="note">${esc(item.dailyNote || (dailySame ? 'Günlük konuşmada da aynen böyle söylenir.' : ''))}</p>
      ${speakOk ? `<div>${play('daily', 'Dinle')}</div>` : ''}
    </section>

    ${c.mistake ? `<p class="small">Hata defterine eklendi: <b>${esc(mistakeLabel(c.mistake.type))}</b>${c.mistake.rule ? ' · ' + esc(c.mistake.rule) : ''}</p>` : ''}
  </div>
  <div class="footer">
    ${c.verdict === 'close' || c.verdict === 'wrong' ? '<button type="button" class="btn" id="retry">Tekrar dene</button>' : ''}
    <button type="button" class="btn btn-primary grow" id="next">${isLast ? 'Bitir' : 'Sıradaki'} ${IC.arrow}</button>
  </div>`;

  ctx.app.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', async () => {
    try { await speak(ctx.state.settings, b.dataset.say === 'daily' ? item.daily : c.fixed, !!b.dataset.slow); } catch (e) { toast(e.message); }
  }));
  ctx.app.querySelector('#retry')?.addEventListener('click', async () => {
    item.check = null;
    await persist();
    drawWrite(ctx, s, item);
    ctx.app.querySelector('#ans')?.focus();
  });
  ctx.app.querySelector('#next').addEventListener('click', () => next(ctx, s));
}

async function next(ctx, s) {
  stopAudio();
  s.idx++;
  if (s.idx >= s.target) return finish(ctx, s);
  await persist();
  window.scrollTo(0, 0);
  renderPractice(ctx);
}

async function finish(ctx, s) {
  s.done = true;
  s.endedAt = new Date().toISOString();
  if (s.mode === 'placement') {
    // İlk yanlış yapılan üniteden başla; öncekiler öğrenilmiş sayılır
    const firstMiss = s.items.findIndex((it) => it.status !== 'first');
    const startUnit = firstMiss < 0 ? 10 : patternById(s.items[firstMiss].pid).unit;
    const before = PATTERNS.filter((p) => p.unit < startUnit).map((p) => p.id);
    if (before.length) await setLearned(before);
    const profile = await loadProfile();
    profile.placementDone = true;
    profile.level = patternsOfUnit(startUnit)[0].level;
    s.placement = { startUnit, level: profile.level };
    await saveProfile(profile);
  }
  if (s.mode === 'learn') s.endScore = masteryOf(await loadMastery(), s.pid).score;
  await persist();
  location.hash = '#ozet';
}

// ---------- Oturum özeti ----------
export async function renderSummary(ctx) {
  const s = await getSession();
  if (!s || !s.done) { location.hash = '#home'; return; }
  const items = s.items.slice(0, s.target);
  const first = items.filter((it) => it.status === 'first').length;
  const retry = items.filter((it) => it.status === 'retry' || it.status === 'fixed').length;
  const missed = items.length - first - retry;
  const pct = items.length ? Math.round((first / items.length) * 100) : 0;
  const wrongItems = items.filter((it) => it.status !== 'first');
  const p = s.pid ? patternById(s.pid) : null;
  const m = p ? masteryOf(await loadMastery(), p.id) : null;
  const nextP = p ? PATTERNS[PATTERNS.indexOf(p) + 1] : null;
  const unitTitle = (n) => UNITS.find((u) => u.n === n)?.title || '';

  let headline = pct >= 75 ? 'Harika çalıştın' : pct >= 50 ? 'İyi gidiyorsun' : 'Bu kalıba biraz daha çalışalım';
  let extra = '';
  if (s.mode === 'placement' && s.placement) {
    headline = 'Seviyen belirlendi';
    extra = `<section class="card"><p>Başlangıç: <b>${s.placement.startUnit}. Ünite: ${esc(unitTitle(s.placement.startUnit))}</b> (seviye ${esc(s.placement.level)}).</p>
      <p class="note">Önceki ünitelerin kalıpları öğrenilmiş sayıldı. İstersen Müfredat’tan onları da çalışabilirsin.</p></section>`;
  }

  ctx.app.innerHTML = `
  <div class="page">
    <div><span class="small">Çalışma bitti${p ? ' · ' + esc(p.title) : ''}</span><h1>${headline}</h1></div>
    <section class="card row ring-card">
      <div class="ring" style="background:conic-gradient(var(--green) 0 ${pct}%, var(--line) ${pct}% 100%)" role="img" aria-label="${items.length} cümleden ${first} tanesi ilk denemede doğru"><div>${first}/${items.length}</div></div>
      <div class="col small-gap">
        <span><b class="t-green">${first}</b> ilk denemede doğru</span>
        <span><b class="t-amber">${retry}</b> ipucuyla ya da ikinci denemede</span>
        <span><b class="t-red">${missed}</b> yanlış ya da cevabı gösterildi</span>
      </div>
    </section>
    ${extra}
    ${m ? `<section class="card"><div class="row between"><span class="cap">Ustalık: ${esc(p.title)}</span><b>${m.score}/100</b></div>${bar(m.score)}
      <p class="note">${m.learned ? 'Bu kalıbı öğrendin. Birkaç gün sonra tekrar sorulacak.' : `Öğrenildi sayılması için 80 puan gerekiyor${s.startScore !== undefined ? ` (bu çalışmada ${s.startScore} → ${m.score})` : ''}.`}</p></section>` : ''}
    ${wrongItems.length ? `
    <section class="card">
      <span class="cap">Düzeltilen cümleler</span>
      ${wrongItems.map((it) => `<div class="corr"><span class="small">${esc(it.tr)}</span><span>${esc(it.answer)}</span></div>`).join('')}
      <p class="small">Bu cümleler 1, 3 ve 7 gün sonra tekrar karşına çıkacak.</p>
    </section>` : ''}
    ${wrongItems.length ? `<button type="button" class="btn btn-primary" id="again">Hatalı ${wrongItems.length} cümleyi şimdi tekrar et</button>` : ''}
    ${s.mode === 'learn' && p ? (m && !m.learned
      ? `<button type="button" class="btn ${wrongItems.length ? '' : 'btn-primary'}" id="more">Bu kalıpla 8 cümle daha</button>`
      : nextP ? `<a class="btn ${wrongItems.length ? '' : 'btn-primary'}" href="#kart/${nextP.id}">Sıradaki kalıp: ${esc(nextP.title)} ${IC.arrow}</a>` : '') : ''}
    <a class="btn" href="#home">Ana sayfa</a>
  </div>`;
  ctx.app.querySelector('#again')?.addEventListener('click', () => startSession(ctx, { mode: 'retry', items: wrongItems, pid: s.pid }));
  ctx.app.querySelector('#more')?.addEventListener('click', () => startSession(ctx, { mode: 'learn', pid: s.pid }));
}

// Ana sayfa için: devam eden oturum bilgisi
export async function activeSessionInfo() {
  const s = await getSession();
  if (!s || s.done) return null;
  const p = s.pid ? patternById(s.pid) : null;
  const what = s.mode === 'placement' ? 'Seviye testi' : s.mode === 'review' ? 'Tekrar' : s.mode === 'mistake' ? mistakeLabel(s.mtype) + ' çalışması' : s.mode === 'retry' ? 'Hatalı cümleler' : p ? p.title : 'Alıştırma';
  return { what, idx: s.idx, target: s.target };
}

export { loadReviews, dueReviews, loadSettings, LEVELS };

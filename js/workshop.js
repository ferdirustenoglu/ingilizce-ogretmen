// Cümle Atölyesi: Türkçe cümleyi parçalarına ayırıp İngilizcesini yazdıran bölüm.
// Rotalar: #atolye · #atolye/kalip · #atolye/konu · #atolye/calis · #atolye/ozet · #atolye/kart.<kalıp>

import { TOPICS, CATEGORIES, LEVELS, topicById } from './topics.js';
import { today } from './db.js';
import { ROLES, LAYERS, PATTERNS, patternById, roleKey } from './workshop-data.js';
import {
  generateItems, checkAnswer, recordResult,
  loadSession, saveSession, loadWsStats, saveWsStats, loadWsHistory, saveWsHistory,
} from './workshop-ai.js';
import { loadMistakes, pickFocusMistakes, recordWordUse, registerWords } from './analysis.js';
import { playText, stopPlayback } from './audio.js';

const SESSION_SIZE = 10;
const BATCH = 5;
const MAX_EXTRA = 6;

// Ekranlar arası geçici durum (kaydedilmez)
const ui = { layer: 'ek', search: '', selected: new Set(), topicSearch: '', openCats: new Set() };
let genPromise = null;
// Oturumun tek kaynağı: bellekteki nesne. Kayıtlar sırayla yazılır (yarış durumu olmaz).
let cur = null;
let saveChain = Promise.resolve();
async function getSession() {
  if (!cur) cur = migrate(await loadSession());
  return cur;
}
// Eski sürümden kalan oturumdaki öğe kodlarını yenilerine çevir
function migrate(sess) {
  if (!sess) return sess;
  const fix = (list) => (list || []).forEach((x) => { x.r = roleKey(x.r); });
  sess.items.forEach((it) => {
    fix(it.pieces); fix(it.parts); fix(it.steps);
    if (it.check) { fix(it.check.userParts); fix(it.check.fixedParts); }
    if (it.firstCheck) fix(it.firstCheck.userParts);
    if (it.hints > 3) it.hints = 3;
  });
  return sess;
}
// Veriler silinince veya yedek yüklenince bellekteki oturumu unut
export function resetWorkshopCache() { cur = null; }

function persist() {
  if (!cur) return saveChain;
  const snap = JSON.parse(JSON.stringify(cur));
  saveChain = saveChain.then(() => saveSession(snap)).catch(() => {});
  return saveChain;
}
let genError = null;

const IC = {
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  down: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 4v16M6 14l6 6 6-6"/></svg>',
  speaker: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/></svg>',
  grid: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFB547" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14 17.5h7M17.5 14v7"/></svg>',
  book: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#AEB8FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 7h6M8 11h6"/></svg>',
  shuffle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3DD68C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  chat: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  bulb: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFB547" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  bank: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFB547" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/></svg>',
};

const lvlIdx = (l) => Math.max(0, LEVELS.indexOf(l));
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const normTxt = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
const trNorm = (s) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- Giriş noktası ----------
export async function renderWorkshop(ctx, sub = '') {
  if (!sub) return renderHome(ctx);
  if (sub === 'kalip') return renderPicker(ctx);
  if (sub === 'konu') return renderTopics(ctx);
  if (sub === 'calis') return renderExercise(ctx);
  if (sub === 'ozet') return renderSummary(ctx);
  if (sub.startsWith('kart.')) return renderCard(ctx, sub.slice(5));
  return renderHome(ctx);
}

// ---------- Ortak parçalar ----------
function header(ctx, { back, title, subtitle, badge }) {
  const { esc } = ctx;
  return `
  <div class="ws-head">
    <a class="icon-btn" href="${back}" aria-label="Geri">${IC.back}</a>
    <div class="ws-head-t">
      ${title}
      ${subtitle ? `<span class="small">${esc(subtitle)}</span>` : ''}
    </div>
    ${badge ? `<span class="ws-badge">${esc(badge)}</span>` : ''}
  </div>`;
}

const patternLabel = (esc, p) => `<span class="ws-chip-tr">${esc(p.tr)}</span>${IC.arrow.replace('currentColor', '#9AA3CF')}<span class="ws-chip-en">${esc(p.en)}</span>`;

// Türkçe cümlenin renkli parçaları (ekler önceki kelimeye bitişik)
function piecesHtml(esc, pieces) {
  const groups = [];
  pieces.forEach((pc) => {
    if (pc.s && groups.length) groups[groups.length - 1].push(pc);
    else groups.push([pc]);
  });
  return groups.map((g) => `<span class="tk-group">${g.map((pc) =>
    `<span class="tk r-${pc.r}"><b>${esc(pc.s && !pc.t.startsWith('-') ? '-' + pc.t : pc.t)}</b><i>${esc(ROLES[pc.r].short)}</i></span>`).join('')}</span>`).join('');
}

function legendHtml(roles) {
  const seen = ['S', 'AUX', 'V', 'OBJ', 'ADV', 'CONJ'].filter((r) => roles.includes(r));
  return `<div class="ws-legend">${seen.map((r) => `<span><span class="dot r-${r}"></span>${ROLES[r].label}</span>`).join('')}</div>`;
}

// Öğe kutuları. mode: 'check' (✓/✗), 'plain', 'hidden' (soru işareti)
function blocksHtml(esc, parts, mode = 'plain') {
  return `<div class="blk-row">${parts.map((pc) => {
    const bad = mode === 'check' && pc.ok === false;
    const mark = mode === 'check' ? (bad ? ' ✗' : ' ✓') : '';
    const text = mode === 'hidden' ? '?' : esc(pc.t);
    return `<span class="blk r-${pc.r}${bad ? ' bad' : ''}"><span>${pc.hl ? `<u>${text}</u>` : text}</span><small>${esc(ROLES[pc.r].short)}${mark}</small></span>`;
  }).join('')}</div>`;
}

function requireKey(ctx) {
  if (ctx.state.settings.apiKey) return true;
  ctx.toast('Önce Ayarlar’dan OpenAI API anahtarını gir.');
  location.hash = '#settings';
  return false;
}

// ---------- Ana ekran ----------
async function renderHome(ctx) {
  const { app, state, esc } = ctx;
  const [session, stats] = [await getSession(), await loadWsStats()];
  const day = stats.days[today()] || { n: 0, first: 0, mistakes: 0 };
  const active = session && !session.done ? session : null;
  const words = state.study.words;

  let cont = '';
  if (active) {
    const pats = active.patternIds.map(patternById).filter(Boolean);
    const topic = active.topicId ? topicById(active.topicId) : null;
    const what = active.mode === 'retry' ? '<span class="muted">Hatalı cümleleri tekrar</span>'
      : pats.length === 1 ? `<span class="ws-chips">${patternLabel(esc, pats[0])}</span>`
        : topic ? `<span style="font-weight:700">${esc(topic.title)}</span>`
          : `<span style="font-weight:700">${active.mode === 'mixed' ? 'Karışık' : pats.length + ' kalıp'}</span>`;
    const pct = Math.round((active.idx / active.target) * 100);
    cont = `
    <section class="card" style="border:1.5px solid var(--line-strong)">
      <div class="row-between"><span class="ws-cap">Kaldığın yer</span><span class="small">${active.idx} / ${active.target} cümle</span></div>
      ${what}
      <div class="bar"><div style="width:${pct}%"></div></div>
      <a class="btn btn-primary" href="#atolye/calis" style="min-height:56px">Devam Et</a>
    </section>`;
  }

  app.innerHTML = `
  <div class="page ws-page">
    <div class="row-between" style="align-items:flex-start">
      <div style="display:flex; flex-direction:column; gap:4px">
        <h1>Cümle Atölyesi</h1>
        <p class="muted">Türkçe cümleyi parçalarına ayır, İngilizcesini kendin kur.</p>
      </div>
      <span class="ws-badge">${esc(state.profile.level)}</span>
    </div>
    ${state.settings.apiKey ? '' : `<div class="note">Başlamadan önce <a href="#settings">Ayarlar</a>'dan OpenAI API anahtarını gir.</div>`}
    ${cont}
    <h2 style="margin-top:4px">Nasıl çalışmak istersin?</h2>
    <a class="ws-option" href="#atolye/kalip">
      <span class="ws-oi" style="background:#3B2F1A">${IC.grid}</span>
      <span class="ws-ot"><b>Kalıp seç</b><span class="small">İskelet, Ek Haritası, Günlük Kalıplar</span></span>${IC.chev}
    </a>
    <a class="ws-option" href="#atolye/konu">
      <span class="ws-oi" style="background:#1E2A5C">${IC.book}</span>
      <span class="ws-ot"><b>Konu seç</b><span class="small">157 konudan biri, cümleler o konudan</span></span>${IC.chev}
    </a>
    <button type="button" class="ws-option" id="wsMixed">
      <span class="ws-oi" style="background:#123B2A">${IC.shuffle}</span>
      <span class="ws-ot"><b>Karışık</b><span class="small">Seviyene ve hata bankana göre</span></span>${IC.chev}
    </button>

    <section class="card">
      <div class="row-between"><h2 style="font-size:14px">Günün kelimeleri cümlelerde</h2><a href="#study" style="font-size:13px; font-weight:600; text-decoration:none">Değiştir</a></div>
      ${words.length
        ? `<div class="ws-chips">${words.slice(0, 8).map((w) => `<span class="pill">${esc(w)}</span>`).join('')}${words.length > 8 ? `<span class="pill" style="color:var(--muted)">+${words.length - 8}</span>` : ''}</div>`
        : '<p class="small">Çalışma sekmesinde kelime yazarsan cümlelerde kullanılır.</p>'}
    </section>

    <div class="grid-3">
      <div class="stat"><b>${day.n}</b><span>bugün cümle</span></div>
      <div class="stat"><b style="color:var(--green-text)">${day.n ? '%' + Math.round((day.first / day.n) * 100) : '–'}</b><span>ilk denemede</span></div>
      <div class="stat"><b style="color:var(--amber)">${day.mistakes}</b><span>yeni hata</span></div>
    </div>
  </div>`;

  app.querySelector('#wsMixed').addEventListener('click', () => startSession(ctx, { mode: 'mixed' }));
}

// ---------- Kalıp seçimi ----------
function patternStatus(stats, id) {
  const s = stats.patterns[id];
  if (!s || !s.seen) return { learned: false, text: '' };
  const learned = s.first >= 5 && s.first / s.seen >= 0.8;
  return { learned, text: `${s.seen} cümle · %${Math.round((s.first / s.seen) * 100)}` };
}

async function renderPicker(ctx) {
  const { app, esc } = ctx;
  const stats = await loadWsStats();
  app.innerHTML = `
  <div class="page ws-page" style="padding-bottom:120px">
    ${header(ctx, { back: '#atolye', title: '<h1 style="font-size:22px">Kalıp seç</h1>' })}
    <label class="search">
      ${ctx.ICON.search}<span class="sr-only">Kalıp ara</span>
      <input id="patSearch" type="search" placeholder="Ek veya kalıp ara: -meli, must…" value="${esc(ui.search)}" autocomplete="off">
    </label>
    <div class="segmented" style="grid-template-columns:repeat(3,minmax(0,1fr))" role="group" aria-label="Katman">
      ${LAYERS.map((l) => `<button type="button" data-layer="${l.id}" aria-pressed="${ui.layer === l.id}">${esc(l.title)}</button>`).join('')}
    </div>
    <div id="patList" style="display:flex; flex-direction:column; gap:8px"></div>
  </div>
  <div class="ws-footbar">
    <span class="small" id="patCount"></span>
    <button type="button" class="btn btn-primary" id="patStart" style="min-height:54px">Başla</button>
  </div>`;

  const list = app.querySelector('#patList');
  const draw = () => {
    const q = trNorm(ui.search.trim());
    const items = PATTERNS.filter((p) => (q ? trNorm(`${p.tr} ${p.en} ${p.title}`).includes(q) : p.layer === ui.layer));
    let html = '';
    let lastGroup = '';
    items.forEach((p) => {
      if (p.group !== lastGroup) {
        lastGroup = p.group;
        html += `<span class="ws-cap" style="margin-top:6px">${esc(p.group)}</span>`;
      }
      const st = patternStatus(stats, p.id);
      const sel = ui.selected.has(p.id);
      html += `
      <div class="ws-prow${sel ? ' sel' : ''}">
        <label class="ws-plabel">
          <input type="checkbox" data-pid="${p.id}" ${sel ? 'checked' : ''}>
          <span class="ws-pmain">
            <span class="ws-chips">${patternLabel(esc, p)}</span>
            <span class="small">${esc(p.title)} · ${esc(p.level)}${st.text ? ' · ' + esc(st.text) : ''}</span>
          </span>
          ${st.learned ? `<span class="ok" aria-label="Öğrenildi" style="color:var(--green)">${IC.check}</span>` : ''}
        </label>
        <a class="icon-btn" href="#atolye/kart.${p.id}" aria-label="${esc(p.title)} kural kartı" style="width:40px;height:40px">${IC.info}</a>
      </div>`;
    });
    list.innerHTML = html || '<p class="muted">Bu aramaya uyan kalıp yok.</p>';
    list.querySelectorAll('input[data-pid]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) ui.selected.add(cb.dataset.pid); else ui.selected.delete(cb.dataset.pid);
      cb.closest('.ws-prow').classList.toggle('sel', cb.checked);
      count();
    }));
  };
  const count = () => {
    const n = ui.selected.size;
    app.querySelector('#patCount').textContent = n ? `${n} kalıp seçildi · ${SESSION_SIZE} cümle · seviye ${ctx.state.profile.level}` : 'Çalışmak istediğin kalıpları seç';
    app.querySelector('#patStart').disabled = !n;
  };
  draw();
  count();
  app.querySelector('#patSearch').addEventListener('input', (e) => { ui.search = e.target.value; draw(); });
  app.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
    ui.layer = b.dataset.layer;
    ui.search = '';
    app.querySelector('#patSearch').value = '';
    app.querySelectorAll('[data-layer]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    draw();
  }));
  app.querySelector('#patStart').addEventListener('click', () => startSession(ctx, { mode: 'pattern', patternIds: [...ui.selected] }));
}

// ---------- Konu seçimi ----------
function renderTopics(ctx) {
  const { app, esc } = ctx;
  app.innerHTML = `
  <div class="page ws-page">
    ${header(ctx, { back: '#atolye', title: '<h1 style="font-size:22px">Konu seç</h1>' })}
    <p class="muted">Bir konuya dokun, o konudan ${SESSION_SIZE} cümle hazırlansın.</p>
    <label class="search">
      ${ctx.ICON.search}<span class="sr-only">Konu ara</span>
      <input id="topSearch" type="search" placeholder="Konu ara (örn. past, otel)" value="${esc(ui.topicSearch)}" autocomplete="off">
    </label>
    <div id="topList" style="display:flex; flex-direction:column; gap:10px"></div>
  </div>`;
  const list = app.querySelector('#topList');
  const draw = () => {
    const q = trNorm(ui.topicSearch.trim());
    list.innerHTML = CATEGORIES.map((c) => {
      const ts = TOPICS.filter((t) => t.cat === c.id && (!q || trNorm(t.title).includes(q)));
      if (!ts.length) return '';
      const open = q || ui.openCats.has(c.id);
      return `<div class="cat">
        <button type="button" class="cat-head" data-cat="${c.id}" aria-expanded="${!!open}">
          <span style="font-weight:700; font-size:15px">${esc(c.title)} <span class="small">(${ts.length})</span></span>${ctx.ICON.chev}
        </button>
        ${open ? ts.map((t) => `<button type="button" class="topic ws-topic" data-tid="${t.id}"><span class="t">${esc(t.title)}</span><span class="level-tag">${esc(t.level)}</span></button>`).join('') : ''}
      </div>`;
    }).join('') || '<p class="muted">Bu aramaya uyan konu yok.</p>';
    list.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      if (ui.openCats.has(b.dataset.cat)) ui.openCats.delete(b.dataset.cat); else ui.openCats.add(b.dataset.cat);
      draw();
    }));
    list.querySelectorAll('[data-tid]').forEach((b) => b.addEventListener('click', () => startSession(ctx, { mode: 'topic', topicId: b.dataset.tid })));
  };
  draw();
  app.querySelector('#topSearch').addEventListener('input', (e) => { ui.topicSearch = e.target.value; draw(); });
}

// ---------- Oturum ----------
async function startSession(ctx, { mode, patternIds = [], topicId = null, n = SESSION_SIZE, retryItems = null }) {
  if (!requireKey(ctx)) return;
  const { state } = ctx;
  const level = state.profile.level;
  let pats = patternIds;
  let focusIds = [];
  if (mode === 'mixed') {
    const stats = await loadWsStats();
    const eligible = PATTERNS.filter((p) => lvlIdx(p.level) <= lvlIdx(level) + 1 && p.group !== 'Araçlar');
    const score = (p) => {
      const s = stats.patterns[p.id];
      return (s && s.seen ? s.first / s.seen : 0.3) + Math.random() * 0.5;
    };
    pats = eligible.sort((a, b) => score(a) - score(b)).slice(0, 3).map((p) => p.id);
    focusIds = await pickFocusMistakes(2);
  }
  const words = shuffle(state.study.words).slice(0, 6);
  if (words.length) registerWords(words);
  const items = retryItems ? retryItems.map((it) => ({ ...it, status: null, attempts: 0, hints: 0, draft: '', check: null })) : [];
  const session = {
    id: 's' + Date.now().toString(36),
    mode, patternIds: pats, topicId, focusIds, words,
    target: retryItems ? items.length : n,
    items, idx: 0, extra: 0,
    wordsOk: [], wordsBad: [], added: [],
    startedAt: new Date().toISOString(), done: false,
  };
  genPromise = null;
  genError = null;
  cur = session;
  await persist();
  location.hash = '#atolye/calis';
}

// Yeterli cümle yoksa arka planda yenilerini üret
function ensureItems(ctx, session, { force = false } = {}) {
  if (genPromise) return genPromise;
  const missing = session.target - session.items.length;
  const ahead = session.items.length - session.idx;
  if (missing <= 0 || (!force && ahead >= 2)) return Promise.resolve(false);
  genError = null;
  genPromise = (async () => {
    const stats = await loadWsStats();
    const mistakes = session.focusIds.length ? (await loadMistakes()).filter((m) => session.focusIds.includes(m.id)) : [];
    const usedFocus = new Set(session.items.map((it) => it.focus).filter(Boolean));
    const topic = session.topicId ? topicById(session.topicId) : null;
    const { items } = await generateItems(ctx.state.settings, {
      level: ctx.state.profile.level,
      n: Math.min(session.items.length ? BATCH : 3, missing),
      patternIds: session.patternIds,
      topic,
      words: session.words,
      focus: mistakes.filter((m) => !usedFocus.has(m.id)),
      avoid: [...stats.recent.slice(-25), ...session.items.map((it) => it.tr)],
    });
    // Bu arada başka oturum başlamış olabilir
    if (!cur || cur.id !== session.id) return false;
    cur.items.push(...items.slice(0, cur.target - cur.items.length));
    await persist();
    return true;
  })().catch((e) => { genError = e; throw e; }).finally(() => { genPromise = null; });
  return genPromise;
}

async function updateStats(session, item, check) {
  const stats = await loadWsStats();
  const d = stats.days[today()] || (stats.days[today()] = { n: 0, first: 0, mistakes: 0 });
  if (item.attempts === 1) {
    d.n++;
    const firstOk = check.verdict === 'correct' && item.hints === 0;
    if (firstOk) d.first++;
    if (item.pattern) {
      const ps = stats.patterns[item.pattern] || (stats.patterns[item.pattern] = { seen: 0, first: 0 });
      ps.seen++;
      if (firstOk) ps.first++;
    }
    stats.recent = [...stats.recent, item.tr].slice(-40);
  }
  // 60 günden eski günleri temizle
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 60) delete stats.days[keys.shift()];
  await saveWsStats(stats);
  return d;
}

async function bumpMistakeStat() {
  const stats = await loadWsStats();
  const d = stats.days[today()] || (stats.days[today()] = { n: 0, first: 0, mistakes: 0 });
  d.mistakes++;
  await saveWsStats(stats);
}

// ---------- Alıştırma ----------
async function renderExercise(ctx) {
  const { app, esc } = ctx;
  const session = await getSession();
  if (!session) { location.hash = '#atolye'; return; }
  if (session.done) { location.hash = '#atolye/ozet'; return; }

  const item = session.items[session.idx];
  if (!item) {
    app.innerHTML = `
    <div class="page ws-page">
      ${header(ctx, { back: '#atolye', title: '<span style="font-weight:700">Cümle Atölyesi</span>' })}
      <div class="card ws-loading" id="wsLoad">
        <div class="typing"><span></span><span></span><span></span></div>
        <p>Cümleler hazırlanıyor…</p>
        <p class="small">İlk cümleler seviyene ve seçimine göre yazılıyor. Bu 15–30 saniye sürebilir.</p>
      </div>
    </div>`;
    try {
      await ensureItems(ctx, session, { force: true });
      if (location.hash === '#atolye/calis') renderExercise(ctx);
    } catch (e) {
      const box = app.querySelector('#wsLoad');
      if (box) box.innerHTML = `<p class="err">${esc(e.message)}</p><button type="button" class="btn btn-primary" id="wsRetry">Tekrar dene</button>`;
      app.querySelector('#wsRetry')?.addEventListener('click', () => renderExercise(ctx));
    }
    return;
  }

  if (item.check) drawResult(ctx, session, item);
  else drawWrite(ctx, session, item);
  // Sıradaki cümleleri arka planda hazırla
  ensureItems(ctx, session).catch(() => {});
}

function exHeader(ctx, session, item) {
  const { esc } = ctx;
  const p = item.pattern ? patternById(item.pattern) : null;
  const topic = session.topicId ? topicById(session.topicId) : null;
  const title = p ? `<span class="ws-chips" style="font-size:15px">${patternLabel(esc, p)}</span>`
    : `<span style="font-weight:700">${esc(topic ? topic.title : session.mode === 'retry' ? 'Tekrar' : 'Karışık')}</span>`;
  const sub = `${p ? p.title + ' · ' : ''}Cümle ${session.idx + 1} / ${session.target}`;
  return header(ctx, { back: '#atolye', title, subtitle: sub, badge: ctx.state.profile.level })
    + `<div class="bar" style="height:6px"><div style="width:${Math.round((session.idx / session.target) * 100)}%"></div></div>`;
}

const HINTS = ['Kalıp', 'Kelimeler', 'Baş harfler'];

// Cevabın her kelimesinin ilk harfi: "I c__ h___ m_ f______"
const initials = (text) => text.split(/\s+/).map((w) => w.replace(/[A-Za-z]/g, (ch, i) => (i === 0 ? ch : '_'))).join(' ');

// Tek bir ipucu paneli (sekmeli gösterim)
function hintPanel(ctx, item, i) {
  const { esc } = ctx;
  if (i === 0) {
    const p = item.pattern ? patternById(item.pattern) : null;
    return `<div class="ws-hint">
      ${p ? `<p class="ws-formula">${esc(p.formula)}</p>` : ''}
      ${item.rule ? `<p class="ws-note">${esc(item.rule)}</p>` : ''}
      <span class="ws-cap">İngilizce sıra</span>${blocksHtml(esc, item.parts.map((x) => ({ ...x, t: ROLES[x.r].label })))}
      ${p ? `<a href="#atolye/kart.${p.id}" class="ws-link">${esc(p.title)} kartı →</a>` : ''}</div>`;
  }
  if (i === 1) {
    return `<div class="ws-hint">${item.words.length
      ? `<div class="ws-words">${item.words.map((w) => `<span><b>${esc(w.tr)}</b> → ${esc(w.en)}</span>`).join('')}</div>`
      : '<p class="ws-note">Bu cümlede bilmen gereken özel bir kelime yok.</p>'}</div>`;
  }
  return `<div class="ws-hint">
    ${blocksHtml(esc, item.parts.map((x) => ({ ...x, t: initials(x.t) })))}
    <p class="ws-note">Her kelimenin ilk harfi. Gerisini sen tamamla.</p></div>`;
}

function drawWrite(ctx, session, item) {
  const { app, esc } = ctx;
  const roles = [...new Set(item.pieces.map((pc) => pc.r))];
  const tab = item.hints ? Math.min(item.tab ?? item.hints - 1, item.hints - 1) : -1;
  app.innerHTML = `
  <div class="page ws-page ws-ex ws-with-composer">
    ${exHeader(ctx, session, item)}
    <section class="card ws-tr">
      <p class="ws-sentence">${esc(item.tr)}</p>
      ${item.pieces.length ? `<div class="tk-line">${piecesHtml(esc, item.pieces)}</div>${legendHtml(roles)}` : ''}
    </section>
    <div class="ws-hintbtns" role="tablist" aria-label="İpuçları">
      ${HINTS.map((h, i) => {
        const open = item.hints > i;
        const nextOne = item.hints === i;
        return `<button type="button" class="ws-hbtn${open ? ' open' : ''}${tab === i ? ' active' : ''}" data-hint="${i}" ${open || nextOne ? '' : 'disabled'}>${open || nextOne ? `<span class="n">${i + 1}</span>` : IC.lock}${h}</button>`;
      }).join('')}
    </div>
    ${tab >= 0 ? hintPanel(ctx, item, tab) : '<p class="small" style="margin:-4px 0 0">Takılırsan ipuçlarını sırayla aç.</p>'}
  </div>
  <div class="ws-composer">
    <div class="ws-comp-row">
      <label class="sr-only" for="wsAns">İngilizcesini yaz</label>
      <textarea id="wsAns" rows="2" autocomplete="off" autocapitalize="sentences" spellcheck="false" placeholder="İngilizcesini yaz…">${esc(item.draft || '')}</textarea>
      <button type="button" class="ws-send" id="wsCheck" aria-label="Kontrol et">${IC.check.replace('width="14" height="14"', 'width="22" height="22"')}</button>
    </div>
    <div class="ws-comp-foot"><span class="small">Enter: kontrol et</span><button type="button" class="link-btn" id="wsShow">Cevabı göster</button></div>
  </div>`;

  const ta = app.querySelector('#wsAns');
  const btn = app.querySelector('#wsCheck');
  const sync = () => { btn.disabled = !ta.value.trim(); };
  sync();
  let t;
  ta.addEventListener('input', () => {
    sync();
    item.draft = ta.value;
    clearTimeout(t);
    t = setTimeout(() => saveItem(session, item), 400);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!btn.disabled) btn.click(); }
  });

  app.querySelectorAll('[data-hint]').forEach((b) => b.addEventListener('click', async () => {
    const i = +b.dataset.hint;
    if (item.hints <= i) item.hints = i + 1;
    item.tab = i;
    item.draft = ta.value;
    await saveItem(session, item);
    const hadFocus = document.activeElement === ta;
    drawWrite(ctx, session, item);
    if (hadFocus) app.querySelector('#wsAns')?.focus();
  }));

  btn.addEventListener('click', () => submit(ctx, session, item, ta.value.trim()));
  app.querySelector('#wsShow').addEventListener('click', async () => {
    item.status = 'shown';
    item.check = {
      verdict: 'shown', summary: '', praise: '', userParts: [], fixed: item.answer, fixedParts: item.parts,
      explain: [], also: null, text: '',
    };
    if (item.attempts === 0) { item.attempts = 1; await updateStats(session, item, { verdict: 'shown' }); }
    await saveItem(session, item);
    drawResult(ctx, session, item);
  });
}

// item, oturumdaki nesnenin kendisi; değişiklikleri kaydetmek yeterli
function saveItem() {
  return persist();
}

async function submit(ctx, session, item, text) {
  const { app, state, toast } = ctx;
  const btn = app.querySelector('#wsCheck');
  btn.disabled = true;
  btn.textContent = 'Kontrol ediliyor…';
  try {
    const check = await checkAnswer(state.settings, state.profile.level, item, text, session.words);
    item.attempts++;
    item.draft = text;
    check.text = text;
    item.check = check;
    if (check.verdict === 'correct') item.status = item.attempts === 1 && item.hints === 0 ? 'first' : 'hint';
    else item.status = 'wrong';
    if (!item.firstCheck) item.firstCheck = { verdict: check.verdict, userParts: check.userParts };

    const { added } = await recordResult(check, item.focus);
    if (added) {
      check.addedKey = added.key;
      check.addedId = added.id;
      if (!session.added.includes(added.id)) { session.added.push(added.id); await bumpMistakeStat(); }
    }
    const lc = (a) => a.map((w) => w.toLowerCase());
    const ok = lc(check.wordsOk).filter((w) => session.words.map((x) => x.toLowerCase()).includes(w));
    const bad = lc(check.wordsBad).filter((w) => session.words.map((x) => x.toLowerCase()).includes(w));
    session.wordsOk = [...new Set([...session.wordsOk, ...ok])];
    session.wordsBad = [...new Set([...session.wordsBad, ...bad])];
    recordWordUse(ok, bad);
    await updateStats(session, item, check);
    await saveItem(session, item);
    drawResult(ctx, session, item);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = 'Kontrol et';
  }
}

const BANNERS = {
  correct: { cls: 'ok', title: 'Doğru!', text: 'Cümleyi doğru kurdun.' },
  close: { cls: 'close', title: 'Neredeyse oldu', text: 'İskelet doğru, küçük bir eksik var.' },
  wrong: { cls: 'bad', title: 'Tekrar bakalım', text: 'Cümlenin yapısında sorun var.' },
  shown: { cls: 'shown', title: 'Doğru cevap', text: 'İncele, bir sonrakinde dene.' },
};

function stepsHtml(esc, steps) {
  return `<div class="ws-steps">${steps.map((st) => `<div class="ws-step">
    <span class="blk r-${st.r}"><small>${esc(ROLES[st.r].short)}</small></span>
    <span><b>${esc(st.tr || '—')}</b> → <b class="en">${esc(st.en)}</b>${st.note ? `<br><span class="small">${esc(st.note)}</span>` : ''}</span>
  </div>`).join('')}</div>`;
}

function drawResult(ctx, session, item) {
  const { app, esc } = ctx;
  const c = item.check;
  const b = BANNERS[c.verdict] || BANNERS.wrong;
  const isLast = session.idx + 1 >= session.target;
  const more = c.verdict !== 'correct' && session.mode !== 'retry' && session.extra < MAX_EXTRA;
  const dailySame = normTxt(item.daily) === normTxt(c.fixed);
  const pat = item.pattern ? patternById(item.pattern) : null;
  const play = (what, label = 'Dinle') => `<button type="button" class="ws-pill ws-play" data-say="${what}" data-speed="normal">${IC.speaker}${label}</button>`;

  app.innerHTML = `
  <div class="page ws-page ws-ex ws-with-footer">
    ${exHeader(ctx, session, item)}
    <p class="ws-sentence sm">${esc(item.tr)}</p>

    <div class="ws-banner ${b.cls}">
      <span class="ws-bi">${c.verdict === 'correct' ? IC.check : '!'}</span>
      <span class="ws-bt"><b>${b.title}</b><span>${esc(c.summary || b.text)}</span></span>
    </div>

    <section class="card ws-c">
      ${c.userParts.length ? `<span class="ws-cap">Senin cevabın</span>${blocksHtml(esc, c.userParts, 'check')}` : ''}
      <span class="ws-cap">Doğru hâli</span>
      ${blocksHtml(esc, c.fixedParts)}
      <div class="row" style="gap:6px">${play('fixed')}<button type="button" class="ws-pill ws-play" data-say="fixed" data-speed="slow">Yavaş</button></div>
    </section>

    ${c.praise ? `<p class="ws-note ws-praise">${esc(c.praise)}</p>` : ''}

    ${c.explain.length ? `
    <section class="card ws-c">
      <span class="ws-cap">Neden?</span>
      ${c.explain.map((e) => `<div class="ws-why">
        <div class="row" style="gap:8px; flex-wrap:wrap">${e.title ? `<b class="ws-why-t">${esc(e.title)}</b>` : ''}${e.tag ? `<span class="ws-tag">${esc(e.tag)}</span>` : ''}</div>
        <p class="ws-note">${esc(e.text)}</p>
        ${e.example ? `<p class="ws-eg">${esc(e.example)}</p>` : ''}
      </div>`).join('')}
    </section>` : ''}

    ${item.steps.length ? `
    <details class="card ws-c ws-details" ${c.verdict === 'correct' ? '' : 'open'}>
      <summary><span class="ws-cap">Adım adım çözüm</span>${pat ? `<span class="small">${esc(pat.formula)}</span>` : ''}</summary>
      ${stepsHtml(esc, item.steps)}
      ${item.rule ? `<p class="ws-note" style="margin-top:4px">${esc(item.rule)}</p>` : ''}
    </details>` : ''}

    ${c.also ? `
    <section class="card ws-c" style="background:var(--green-bg)">
      <span class="ws-cap" style="color:var(--green-text)">Bu da doğru</span>
      <p class="ws-en">${esc(c.also.en)}</p>
      ${c.also.note ? `<p class="ws-note" style="color:#BFEFD6">${esc(c.also.note)}</p>` : ''}
    </section>` : ''}

    <section class="card ws-c ws-daily">
      <span class="ws-cap" style="color:var(--accent-text); display:flex; align-items:center; gap:6px">${IC.chat} Günlük konuşmada böyle denir</span>
      <p class="ws-en">${esc(item.daily)}</p>
      <p class="ws-note">${esc(item.dailyNote || (dailySame ? 'Günlük konuşmada da aynen böyle söylenir.' : ''))}</p>
      <div>${play('daily')}</div>
    </section>

    ${c.addedKey ? `<div class="row small" style="gap:8px; align-items:flex-start">${IC.bank}<span>Hata Bankası'na eklendi: <b style="color:var(--text)">${esc(c.mistake?.rule_tr || c.addedKey)}</b></span></div>` : ''}
    ${more ? `<button type="button" class="link-btn" id="wsMore" style="text-align:left">+ Aynı kalıpla 2 cümle daha ekle</button>` : ''}
  </div>
  <div class="ws-footer">
    ${c.verdict === 'close' || c.verdict === 'wrong' ? '<button type="button" class="btn ws-fbtn" id="wsRetry">Tekrar dene</button>' : ''}
    <button type="button" class="btn btn-primary ws-fbtn" id="wsNext" style="flex:1">${isLast ? 'Oturumu bitir' : 'Sıradaki'} ${IC.arrow}</button>
  </div>`;

  app.querySelectorAll('.ws-play').forEach((btn) => btn.addEventListener('click', async () => {
    const text = btn.dataset.say === 'daily' ? item.daily : c.fixed;
    try { await playText(ctx.state.settings, ctx.state.profile.level, text, btn.dataset.speed); } catch (e) { ctx.toast(e.message); }
  }));
  app.querySelector('#wsRetry')?.addEventListener('click', async () => {
    item.check = null;
    await saveItem(session, item);
    drawWrite(ctx, session, item);
    app.querySelector('#wsAns')?.focus();
  });
  app.querySelector('#wsNext').addEventListener('click', () => next(ctx, session));
  app.querySelector('#wsMore')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Cümleler hazırlanıyor…';
    try {
      const mistakes = c.addedId ? (await loadMistakes()).filter((m) => m.id === c.addedId) : [];
      const { items } = await generateItems(ctx.state.settings, {
        level: ctx.state.profile.level,
        n: 2,
        patternIds: item.pattern ? [item.pattern] : session.patternIds,
        topic: session.topicId ? topicById(session.topicId) : null,
        words: session.words,
        focus: mistakes,
        avoid: session.items.map((x) => x.tr),
      });
      const add = items.slice(0, 2);
      session.items.splice(session.idx + 1, 0, ...add);
      session.target += add.length;
      session.extra += add.length;
      await persist();
      btn.textContent = `✓ ${add.length} cümle eklendi`;
      app.querySelector('#wsNext').innerHTML = 'Sıradaki ' + IC.arrow;
    } catch (err) {
      ctx.toast(err.message);
      btn.disabled = false;
      btn.textContent = '+ Aynı kalıpla 2 cümle daha ekle';
    }
  });
}

async function next(ctx, session) {
  stopPlayback();
  session.idx = Math.min(session.idx + 1, session.target);
  if (session.idx >= session.target) {
    session.done = true;
    session.endedAt = new Date().toISOString();
    await persist();
    const hist = await loadWsHistory();
    const counts = countStatus(session.items.slice(0, session.target));
    hist.unshift({ id: session.id, at: session.endedAt, mode: session.mode, patternIds: session.patternIds, topicId: session.topicId, ...counts });
    await saveWsHistory(hist);
    location.hash = '#atolye/ozet';
    return;
  }
  await persist();
  window.scrollTo(0, 0);
  renderExercise(ctx);
}

function countStatus(items) {
  const c = { total: items.length, first: 0, hint: 0, missed: 0 };
  items.forEach((it) => {
    if (it.status === 'first') c.first++;
    else if (it.status === 'hint') c.hint++;
    else c.missed++;
  });
  return c;
}

// ---------- Oturum özeti ----------
async function renderSummary(ctx) {
  const { app, esc, state } = ctx;
  const session = await getSession();
  if (!session || !session.done) { location.hash = '#atolye'; return; }
  const items = session.items.slice(0, session.target);
  const c = countStatus(items);
  const pct = c.total ? Math.round((c.first / c.total) * 100) : 0;

  // Öğe bazında başarı (ilk denemeye göre)
  const roleStat = {};
  items.forEach((it) => (it.firstCheck?.userParts || []).forEach((pc) => {
    if (!['S', 'AUX', 'V', 'OBJ', 'ADV'].includes(pc.r)) return;
    const s = roleStat[pc.r] || (roleStat[pc.r] = { ok: 0, n: 0 });
    s.n++;
    if (pc.ok !== false) s.ok++;
  }));
  const roles = ['S', 'AUX', 'V', 'OBJ', 'ADV'].filter((r) => roleStat[r]);
  const weakest = roles.filter((r) => roleStat[r].ok < roleStat[r].n).sort((a, b) => roleStat[a].ok / roleStat[a].n - roleStat[b].ok / roleStat[b].n)[0];
  const corrected = items.filter((it) => it.status !== 'first');
  const pats = session.patternIds.map(patternById).filter(Boolean);
  const topic = session.topicId ? topicById(session.topicId) : null;
  const what = session.mode === 'retry' ? 'Tekrar çalışması' : topic ? topic.title : pats.length ? pats.map((p) => `${p.tr} → ${p.en}`).join(', ') : 'Karışık';
  const weakText = {
    S: 'özneyi (I, you, he…) yazmakta', AUX: 'yardımcı fiilde (can, must, did, have…)', V: 'fiilin doğru hâlinde',
    OBJ: 'nesnede: edat, a / the ve çoğul -s', ADV: 'zarfların yerinde',
  };

  app.innerHTML = `
  <div class="page ws-page">
    <div style="display:flex; flex-direction:column; gap:4px">
      <span class="small" style="font-weight:600">Oturum bitti · ${esc(what)}</span>
      <h1>${pct >= 70 ? 'Güzel çalıştın' : 'Çalışmaya devam'}</h1>
    </div>

    <section class="card" style="flex-direction:row; align-items:center; gap:16px">
      <div class="ws-ring" style="background:conic-gradient(var(--green) 0 ${pct}%, var(--line) ${pct}% 100%)" role="img" aria-label="${c.total} cümleden ${c.first} tanesi ilk denemede doğru">
        <div>${c.first}/${c.total}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; font-size:14px">
        <span><b style="color:var(--green-text)">${c.first}</b> ilk denemede doğru</span>
        <span><b style="color:var(--amber)">${c.hint}</b> ipucuyla ya da ikinci denemede</span>
        <span><b style="color:var(--danger)">${c.missed}</b> yanlış ya da cevabı gösterildi</span>
      </div>
    </section>

    ${roles.length ? `
    <section class="card">
      <span class="ws-cap">Öğe bazında</span>
      <div class="ws-rolegrid">${roles.map((r) => `<div class="r-${r}${r === weakest ? ' weak' : ''}"><b>${roleStat[r].ok}/${roleStat[r].n}</b><span>${ROLES[r].label}</span></div>`).join('')}</div>
      ${weakest ? `<p class="ws-note">En çok <b>${weakText[weakest]}</b> takıldın. Bir sonraki karışık çalışmada bu hatalar tekrar karşına çıkacak.</p>` : '<p class="ws-note">Bütün öğeleri doğru yerleştirdin.</p>'}
    </section>` : ''}

    ${corrected.length ? `
    <section class="card">
      <span class="ws-cap">Düzeltilen cümleler</span>
      ${corrected.map((it) => `<div class="ws-corr"><span class="small">${esc(it.tr)}</span><span>${esc(it.check?.fixed || it.answer)}</span></div>`).join('')}
    </section>` : ''}

    ${session.words.length ? `
    <div class="ws-chips">${session.words.map((w) => {
      const k = w.toLowerCase();
      const cls = session.wordsBad.includes(k) ? 'warn' : session.wordsOk.includes(k) ? 'good' : '';
      return `<span class="pill ws-w ${cls}">${esc(w)} ${cls === 'good' ? '✓' : cls === 'warn' ? '!' : '○'}</span>`;
    }).join('')}</div>` : ''}

    ${session.added.length ? `<p class="small">${session.added.length} yeni hata Hata Bankası'na eklendi. <a href="#progress">İlerleme’de gör</a></p>` : ''}

    ${corrected.length ? `<button type="button" class="btn btn-primary btn-big" id="wsAgain">Hatalı ${corrected.length} cümleyi tekrar çalış</button>` : ''}
    <a class="btn" href="#atolye">Atölyeye dön</a>
  </div>`;

  app.querySelector('#wsAgain')?.addEventListener('click', () => startSession(ctx, {
    mode: 'retry', patternIds: session.patternIds, topicId: session.topicId, retryItems: corrected,
  }));
  void state;
}

// ---------- Kural kartı ----------
function renderCard(ctx, id) {
  const { app, esc } = ctx;
  const p = patternById(id);
  if (!p) { location.hash = '#atolye/kalip'; return; }
  const layer = LAYERS.find((l) => l.id === p.layer);
  app.innerHTML = `
  <div class="page ws-page">
    ${header(ctx, { back: '#atolye/kalip', title: `<span class="small" style="font-weight:600">Kural kartı · ${esc(layer ? layer.title : '')}</span><h1 style="font-size:22px">${esc(p.title)}</h1>` })}
    <div class="ws-chips">${patternLabel(esc, p)}<span class="level-tag">${esc(p.level)}</span></div>
    <p style="color:var(--soft); font-size:15px; line-height:1.55">${esc(p.explain)}</p>
    <section class="card"><span class="ws-cap">Kalıp</span><p class="ws-formula">${esc(p.formula)}</p></section>
    <section class="card" style="gap:0; padding:4px 16px">
      ${p.examples.map((e, i) => `<div class="ws-ex-row"${i === p.examples.length - 1 ? ' style="border-bottom:none"' : ''}>
        <span class="small" style="font-size:14px">${esc(e.tr)}</span>
        <span style="display:flex; align-items:center; justify-content:space-between; gap:8px"><b style="font-size:16px">${esc(e.en)}</b>
        <button type="button" class="icon-btn ws-say" data-text="${esc(e.en.replace(/^.*→\s*/, ''))}" aria-label="Dinle" style="width:40px;height:40px;flex-shrink:0">${IC.speaker}</button></span>
      </div>`).join('')}
    </section>
    <div class="ws-tipbox">${IC.bulb}<p>${esc(p.tip)}</p></div>
    <button type="button" class="btn btn-primary btn-big" id="wsCardGo">Bu kuralla 5 cümle çalış</button>
  </div>`;
  app.querySelectorAll('.ws-say').forEach((b) => b.addEventListener('click', async () => {
    if (!ctx.state.settings.apiKey) { ctx.toast('Dinlemek için API anahtarı gerekli.'); return; }
    try { await playText(ctx.state.settings, ctx.state.profile.level, b.dataset.text, 'normal'); } catch (e) { ctx.toast(e.message); }
  }));
  app.querySelector('#wsCardGo').addEventListener('click', () => startSession(ctx, { mode: 'pattern', patternIds: [p.id], n: 5 }));
}

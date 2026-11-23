import { TOPICS, CATEGORIES, LEVELS, topicById, levelGroup } from './topics.js';
import {
  loadSettings, saveSettings, loadProfile, loadStudy, saveStudy,
  loadSavedStudies, saveSavedStudies, exportAll, importAll, db, loadCosts, today,
} from './db.js';
import { testApiKey } from './openai.js';
import { renderLesson, leaveLesson, previewVoice, archiveLesson } from './lesson.js';
import { renderSummary } from './summary.js';
import { renderProgress } from './progress.js';
import { renderPron, loadPronWords } from './pron.js';
import { stopPlayback } from './audio.js';
import { renderWordCards } from './wordcards.js';
import { levelProgress } from './analysis.js';
import { renderWorkshop } from './workshop.js';

// ---------- Uygulama durumu ----------
const state = {
  settings: null,
  profile: null,
  study: null,
  savedStudies: [],
  // Çalışma ekranı filtreleri (kaydedilmez)
  search: '',
  levelFilter: 'all',
  openCats: new Set(),
};

const app = document.getElementById('app');

// ---------- Yardımcılar ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Türkçe büyük/küçük harf duyarsız arama
const norm = (s) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '');

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const parseWords = (text) =>
  text.split('\n').map((w) => w.trim()).filter(Boolean);

const nextLevel = (lvl) => LEVELS[Math.min(LEVELS.indexOf(lvl) + 1, LEVELS.length - 1)];

const ICON = {
  mic: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFB547" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  micSmall: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#AEB8FF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  chev: '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
};

// ---------- Yönlendirme ----------
const C = () => ({ app, state, esc, toast, ICON });
const ROUTES = {
  home: renderHome,
  study: renderStudy,
  progress: (sub) => renderProgress(C(), sub),
  settings: renderSettings,
  lesson: () => renderLesson(C()),
  summary: (sub) => renderSummary(C(), sub),
  pron: (sub) => renderPron(C(), sub),
  atolye: (sub) => renderWorkshop(C(), sub),
};
let currentRoute = null;

function route() {
  const [name, sub] = (location.hash || '#home').slice(1).split('/');
  const render = ROUTES[name] || renderHome;
  if (currentRoute === 'lesson' && name !== 'lesson') leaveLesson();
  if (currentRoute !== name) stopPlayback();
  currentRoute = name;
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.querySelector('.nav').style.display = name === 'lesson' || (name === 'atolye' && sub === 'calis') ? 'none' : '';
  render(sub);
  window.scrollTo(0, 0);
}

// ---------- Ana Sayfa ----------
async function renderHome() {
  const { profile, study, settings } = state;
  const costs = await loadCosts();
  const todayCost = costs.days[today()] || 0;
  const lessonSaved = await db.get('lesson');
  const hasLesson = lessonSaved && lessonSaved.messages && lessonSaved.messages.length;
  const prog = levelProgress(profile);
  const hardCount = Object.keys(await loadPronWords()).length;
  const topics = study.topics.map(topicById).filter(Boolean);
  const modeLabel = settings.voiceMode === 'realtime' ? 'Canlı Sohbet' : 'Bas-Konuş';

  app.innerHTML = `
  <div class="page">
    <div>
      <p class="muted" style="font-weight:500">Merhaba</p>
      <h1>Konuşmaya hazır mısın?</h1>
    </div>

    ${settings.apiKey ? '' : `<div class="note">Başlamadan önce <a href="#settings">Ayarlar</a>'dan OpenAI API anahtarını gir.</div>`}

    <section class="card level-card">
      <div class="level-badge">${esc(profile.level)}</div>
      <div style="flex:1; display:flex; flex-direction:column; gap:8px">
        <p class="small" style="font-weight:600">Seviyen</p>
        <p style="font-size:15px; font-weight:600">${profile.placementDone ? esc(nextLevel(profile.level)) + "'e ilerleme" : 'Seviye belirleniyor'}</p>
        <div class="bar"><div style="width:${prog.pct}%"></div></div>
        <p class="small">${profile.sentenceCount ? esc(prog.text) : 'Seviyen ilk derste ölçülecek'}</p>
      </div>
    </section>

    <div style="display:flex; flex-direction:column; gap:10px">
      <a class="btn btn-primary btn-big" href="#lesson">${ICON.mic} ${hasLesson ? 'Derse Devam Et' : 'Derse Başla'}</a>
      ${hasLesson ? `<button type="button" class="btn" id="homeNew">${ICON.plus} Yeni Ders</button>` : ''}
    </div>

    <section class="card">
      <div class="row-between">
        <h2>Aktif çalışma</h2>
        <a href="#study" style="font-size:13px; font-weight:600; text-decoration:none">Düzenle</a>
      </div>
      ${topics.length
        ? `<div style="display:flex; flex-wrap:wrap; gap:8px">${topics.map((t) => `<span class="pill">${esc(t.title)}</span>`).join('')}</div>`
        : `<p class="muted">Konu seçilmedi. Öğretmen serbest sohbet yapar.</p>`}
      <p class="small">${study.words.length} kelime</p>
    </section>

    <a class="card row" href="#atolye" style="flex-direction:row; align-items:center; gap:12px; text-decoration:none; color:var(--text)">
      <div style="width:40px; height:40px; border-radius:12px; background:var(--amber-bg); color:var(--amber); display:flex; align-items:center; justify-content:center; flex-shrink:0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; gap:2px">
        <span style="font-size:14px; font-weight:700">Cümle Atölyesi</span>
        <span class="small">Türkçe cümleyi kalıplarla İngilizceye çevir</span>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </a>

    <a class="card row" href="#pron" style="flex-direction:row; align-items:center; gap:12px; text-decoration:none; color:var(--text)">
      <div style="width:40px; height:40px; border-radius:12px; background:var(--surface-2); color:var(--accent-text); display:flex; align-items:center; justify-content:center; flex-shrink:0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>
      </div>
      <div style="flex:1; display:flex; flex-direction:column; gap:2px">
        <span style="font-size:14px; font-weight:700">Telaffuz Çalışması</span>
        <span class="small">${hardCount ? hardCount + ' kelimede zorlandın' : 'Zor kelimeleri dinle, söyle, puan al'}</span>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </a>

    <div class="grid-3">
      <div class="stat"><b>${profile.sentenceCount || 0}</b><span>toplam cümle</span></div>
      <div class="stat"><b>${study.words.length}</b><span>hedef kelime</span></div>
      <div class="stat"><b>$${todayCost.toFixed(2)}</b><span>bugün maliyet</span></div>
    </div>

    <div class="row small" style="gap:6px">${settings.voiceMode === 'realtime' ? ICON.bolt : ICON.micSmall} Ses modu: ${modeLabel} · Model: ${settings.modelSize === 'mini' ? 'Mini' : 'Büyük'}</div>
  </div>`;

  app.querySelector('#homeNew')?.addEventListener('click', async () => {
    if (!confirm('Mevcut ders bitsin ve yeni ders başlasın mı?')) return;
    const l = await db.get('lesson');
    if (l && l.messages.some((m) => m.role === 'student')) await archiveLesson(l, state.profile.level);
    else await db.del('lesson');
    location.hash = '#lesson';
  });
}



// ---------- Çalışma ----------
function renderStudy() {
  const filters = ['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  // Seçili konusu olan kategoriler açık başlasın
  state.study.topics.forEach((id) => state.openCats.add(topicById(id)?.cat));
  app.innerHTML = `
  <div class="page">
    <div style="display:flex; flex-direction:column; gap:4px">
      <h1>Çalışma Oluştur</h1>
      <p class="muted">Konu seç, kelimelerini yaz, öğretmen ona göre konuşsun.</p>
    </div>

    <label class="search">
      ${ICON.search}
      <span class="sr-only">Konu ara</span>
      <input id="topicSearch" type="search" placeholder="Konu ara (örn. past, otel)" value="${esc(state.search)}" autocomplete="off">
    </label>

    <div class="row" style="flex-wrap:wrap; gap:8px" role="group" aria-label="Seviye filtresi">
      ${filters.map((f) => `<button type="button" class="pill-filter" data-level="${f}" aria-pressed="${state.levelFilter === f}">${f === 'all' ? 'Tümü' : f}</button>`).join('')}
    </div>

    <div class="row-between">
      <p id="selCount" style="font-size:13px; font-weight:700; color:var(--green)"></p>
      <button type="button" class="link-btn" id="clearTopics">Seçimi temizle</button>
    </div>

    <div id="topicList" style="display:flex; flex-direction:column; gap:10px"></div>

    <section class="card">
      <div class="row-between">
        <label for="words" style="font-size:15px; font-weight:700">Kelimeler</label>
        <span class="small" id="wordCount"></span>
      </div>
      <p class="small">Her satıra bir kelime yaz.</p>
      <textarea id="words" class="textarea" rows="10" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="go&#10;buy&#10;forget">${esc(state.study.words.join('\n'))}</textarea>
      <button type="button" class="btn btn-small" id="showCards">Kelime kartlarını göster</button>
      <div id="wordCards" style="display:flex; flex-direction:column; gap:10px"></div>
    </section>

    <section class="card">
      <h2>Kayıtlı çalışmalar</h2>
      <div class="row">
        <label for="studyName" class="sr-only">Çalışma adı</label>
        <input id="studyName" class="input" placeholder="Çalışma adı (örn. Pazartesi fiilleri)" style="flex:1; min-width:0">
        <button type="button" class="btn btn-small" id="saveStudy">Kaydet</button>
      </div>
      <div id="savedList" style="display:flex; flex-direction:column"></div>
    </section>

    <button type="button" class="btn btn-primary btn-big" id="startStudy">Bu Çalışmayla Başla</button>
  </div>`;

  renderTopicList();
  updateCounts();
  renderSavedList();

  // Olaylar
  app.querySelector('#topicSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTopicList();
  });
  app.querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      state.levelFilter = b.dataset.level;
      app.querySelectorAll('[data-level]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      renderTopicList();
    })
  );
  app.querySelector('#clearTopics').addEventListener('click', async () => {
    state.study.topics = [];
    await saveStudy(state.study);
    renderTopicList();
    updateCounts();
  });
  const saveWords = debounce(async (text) => {
    state.study.words = parseWords(text);
    await saveStudy(state.study);
  }, 400);
  app.querySelector('#words').addEventListener('input', (e) => {
    app.querySelector('#wordCount').textContent = parseWords(e.target.value).length + ' kelime';
    saveWords(e.target.value);
  });
  app.querySelector('#showCards').addEventListener('click', async (e) => {
    const words = parseWords(app.querySelector('#words').value);
    if (!words.length) { toast('Önce kelime yaz.'); return; }
    state.study.words = words;
    await saveStudy(state.study);
    e.target.disabled = true;
    await renderWordCards({ state, esc, toast }, app.querySelector('#wordCards'), words);
    e.target.disabled = false;
  });

  app.querySelector('#startStudy').addEventListener('click', async () => {
    state.study.words = parseWords(app.querySelector('#words').value);
    await saveStudy(state.study);
    const l = await db.get('lesson');
    if (l && l.messages.some((m) => m.role === 'student')) {
      if (!confirm('Devam eden bir ders var. O ders bitsin ve bu çalışmayla yeni ders başlasın mı?')) return;
      await archiveLesson(l, state.profile.level);
    } else if (l) {
      await db.del('lesson');
    }
    location.hash = '#lesson';
  });

  app.querySelector('#saveStudy').addEventListener('click', async () => {
    const input = app.querySelector('#studyName');
    const name = input.value.trim();
    if (!name) { toast('Önce çalışmaya bir ad ver.'); input.focus(); return; }
    state.study.words = parseWords(app.querySelector('#words').value);
    const existing = state.savedStudies.findIndex((s) => s.name === name);
    const item = { name, topics: [...state.study.topics], words: [...state.study.words], savedAt: new Date().toISOString() };
    if (existing >= 0) state.savedStudies[existing] = item;
    else state.savedStudies.unshift(item);
    await saveSavedStudies(state.savedStudies);
    input.value = '';
    renderSavedList();
    toast('"' + name + '" kaydedildi.');
  });
}

function renderTopicList() {
  const box = app.querySelector('#topicList');
  if (!box) return;
  const q = norm(state.search.trim());
  const selected = new Set(state.study.topics);
  const filtering = q || state.levelFilter !== 'all';

  const html = CATEGORIES.map((cat) => {
    const items = TOPICS.filter((t) =>
      t.cat === cat.id &&
      (state.levelFilter === 'all' || levelGroup(t.level) === state.levelFilter) &&
      (!q || norm(t.title).includes(q))
    );
    if (!items.length) return '';
    const selInCat = items.filter((t) => selected.has(t.id)).length;
    const open = filtering || state.openCats.has(cat.id);
    return `
    <section class="cat">
      <button type="button" class="cat-head" data-cat="${cat.id}" aria-expanded="${open}">
        <span style="display:flex; flex-direction:column; gap:2px">
          <span style="font-size:15px; font-weight:700">${esc(cat.title)}</span>
          <span class="small">${items.length} konu${selInCat ? ` · <span style="color:var(--green); font-weight:700">${selInCat} seçili</span>` : ''}</span>
        </span>
        ${ICON.chev}
      </button>
      ${open ? items.map((t) => `
        <label class="topic">
          <input type="checkbox" data-topic="${t.id}" ${selected.has(t.id) ? 'checked' : ''}>
          <span class="t">${esc(t.title)}</span>
          <span class="level-tag">${t.level}</span>
        </label>`).join('') : ''}
    </section>`;
  }).join('');

  box.innerHTML = html || '<p class="muted">Aramana uyan konu yok.</p>';

  box.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.cat;
      if (state.openCats.has(id)) state.openCats.delete(id);
      else state.openCats.add(id);
      renderTopicList();
    })
  );
  box.querySelectorAll('[data-topic]').forEach((c) =>
    c.addEventListener('change', async () => {
      const id = c.dataset.topic;
      const set = new Set(state.study.topics);
      if (c.checked) set.add(id); else set.delete(id);
      state.study.topics = TOPICS.map((t) => t.id).filter((x) => set.has(x));
      await saveStudy(state.study);
      updateCounts();
      // Kategori başlığındaki "seçili" sayısını güncelle, açık/kapalı durumu koru
      const catId = topicById(id).cat;
      state.openCats.add(catId);
      renderTopicList();
    })
  );
}

function updateCounts() {
  const n = state.study.topics.length;
  const el = app.querySelector('#selCount');
  if (el) el.textContent = n ? `${n} konu seçildi` : 'Konu seçilmedi (serbest sohbet)';
  const wc = app.querySelector('#wordCount');
  if (wc) wc.textContent = state.study.words.length + ' kelime';
}

function renderSavedList() {
  const box = app.querySelector('#savedList');
  if (!box) return;
  if (!state.savedStudies.length) {
    box.innerHTML = '<p class="small">Henüz kayıtlı çalışma yok.</p>';
    return;
  }
  box.innerHTML = state.savedStudies.map((s, i) => `
    <div class="row-between" style="border-top:1px solid var(--line); min-height:52px">
      <div style="display:flex; flex-direction:column; gap:2px; min-width:0">
        <span style="font-size:14px; font-weight:600">${esc(s.name)}</span>
        <span class="small">${s.topics.length} konu · ${s.words.length} kelime</span>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn btn-small" data-load="${i}">Yükle</button>
        <button type="button" class="btn btn-small btn-danger" data-del="${i}" aria-label="${esc(s.name)} çalışmasını sil">Sil</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-load]').forEach((b) =>
    b.addEventListener('click', async () => {
      const s = state.savedStudies[+b.dataset.load];
      state.study = { topics: [...s.topics], words: [...s.words] };
      await saveStudy(state.study);
      s.topics.forEach((id) => state.openCats.add(topicById(id)?.cat));
      renderStudy();
      toast('"' + s.name + '" yüklendi.');
    })
  );
  box.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const i = +b.dataset.del;
      const name = state.savedStudies[i].name;
      if (!confirm('"' + name + '" silinsin mi?')) return;
      state.savedStudies.splice(i, 1);
      await saveSavedStudies(state.savedStudies);
      renderSavedList();
    })
  );
}

// ---------- Ayarlar ----------
const VOICES = [
  ['marin', 'Marin (kadın, doğal)'],
  ['cedar', 'Cedar (erkek, doğal)'],
  ['coral', 'Coral (kadın, sıcak)'],
  ['sage', 'Sage (kadın, sakin)'],
  ['ash', 'Ash (erkek, net)'],
  ['verse', 'Verse (erkek, canlı)'],
  ['alloy', 'Alloy (nötr)'],
];

function seg(name, value, options) {
  return `<div class="segmented" style="grid-template-columns:repeat(${options.length}, minmax(0,1fr))" role="group">
    ${options.map(([v, label]) => `<button type="button" data-seg="${name}" data-val="${v}" aria-pressed="${value === v}">${label}</button>`).join('')}
  </div>`;
}

function renderSettings() {
  const s = state.settings;
  const m = s.models;
  app.innerHTML = `
  <div class="page">
    <h1>Ayarlar</h1>

    <section class="card">
      <label for="apiKey" style="font-size:15px; font-weight:700">OpenAI API anahtarı</label>
      <div class="row">
        <input id="apiKey" class="input" type="password" autocomplete="off" placeholder="sk-..." value="${esc(s.apiKey)}" style="flex:1; min-width:0">
        <button type="button" class="btn btn-small" id="toggleKey">Göster</button>
      </div>
      <button type="button" class="btn btn-small" id="testKey">Bağlantıyı test et</button>
      <p id="keyResult" class="small">Anahtar sadece bu telefonda saklanır.</p>
    </section>

    <section class="card" role="radiogroup" aria-label="Ses modu">
      <h2>Ses modu</h2>
      <label class="choice">
        <input type="radio" name="voiceMode" value="realtime" ${s.voiceMode === 'realtime' ? 'checked' : ''}>
        <span class="ct">
          <span class="title">${ICON.bolt} Canlı Sohbet</span>
          <span class="desc">Gerçek bir öğretmenle telefonda konuşur gibi. Sen konuşmayı bitirince öğretmen hemen cevap verir. İstersen onun sözünü kesebilirsin. En doğal deneyim budur ama daha pahalıdır.</span>
          <span class="small" style="color:var(--amber); font-weight:600">Tahmini: 5$ ≈ 2-4 saat (mini model)</span>
        </span>
      </label>
      <label class="choice">
        <input type="radio" name="voiceMode" value="ptt" ${s.voiceMode === 'ptt' ? 'checked' : ''}>
        <span class="ct">
          <span class="title">${ICON.micSmall} Bas-Konuş</span>
          <span class="desc">Düğmeye basılı tutarak konuşursun. Bıraktığında sesin yazıya çevrilir, öğretmen düşünür ve sesli cevap verir. Her cevapta 1-3 saniye bekleme olur. Konuşmadan önce düşünmek istediğinde de rahattır.</span>
          <span class="small" style="color:var(--green); font-weight:600">Birkaç kat daha ucuz</span>
        </span>
      </label>
    </section>

    <section class="card">
      <h2>Konuşma modeli</h2>
      ${seg('modelSize', s.modelSize, [['mini', 'Mini'], ['large', 'Büyük']])}
      <p class="small">Büyük model daha akıllı ama yaklaşık 3 kat daha pahalı. Sadece Canlı Sohbet modunu etkiler.</p>
      <details>
        <summary style="font-size:13px; font-weight:600; color:var(--accent-text); min-height:44px; display:flex; align-items:center; cursor:pointer">Model adlarını düzenle</summary>
        <div style="display:flex; flex-direction:column; gap:10px; padding-top:6px">
          ${[
            ['realtimeMini', 'Canlı Sohbet – mini'],
            ['realtimeLarge', 'Canlı Sohbet – büyük'],
            ['chat', 'Bas-Konuş öğretmen modeli'],
            ['analysis', 'Analiz modeli'],
            ['transcribe', 'Sesi yazıya çevirme – standart'],
            ['transcribeHigh', 'Sesi yazıya çevirme – yüksek'],
            ['tts', 'Seslendirme'],
            ['audio', 'Telaffuz değerlendirme / yedek seslendirme'],
          ].map(([k, label]) => `
            <label style="display:flex; flex-direction:column; gap:4px">
              <span class="small" style="font-weight:600">${label}</span>
              <input class="input" data-model="${k}" value="${esc(m[k])}" autocomplete="off" autocapitalize="none" spellcheck="false">
            </label>`).join('')}
          <button type="button" class="link-btn" id="resetModels">Varsayılan model adlarına dön</button>
        </div>
      </details>
    </section>

    <section class="card">
      <h2>Ses tanıma kalitesi</h2>
      ${seg('transcribeQuality', s.transcribeQuality, [['high', 'Yüksek'], ['standard', 'Standart']])}
      <p class="small">Yüksek: aksanlı konuşmayı daha iyi anlar (dakikası ~0,006$). Standart: daha ucuz (dakikası ~0,003$). 10 dakikalık derste fark yaklaşık 3 kuruş.</p>
    </section>

    <section class="card">
      <label for="voice" style="font-size:15px; font-weight:700">Öğretmen sesi</label>
      <select id="voice" class="select">
        ${VOICES.map(([v, label]) => `<option value="${v}" ${s.voice === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-small" id="previewVoice">Sesi dinle</button>
    </section>

    <section class="card">
      <h2>Konuşma hızı</h2>
      ${seg('speed', s.speed, [['auto', 'Otomatik'], ['slow', 'Yavaş'], ['normal', 'Normal'], ['fast', 'Hızlı']])}
      <p class="small">Otomatik: seviyene göre ayarlanır.</p>
    </section>

    <section class="card">
      <h2>Düzeltme yoğunluğu</h2>
      ${seg('correction', s.correction, [['all', 'Hepsi'], ['important', 'Sadece önemliler']])}
      <p class="small">"Sadece önemliler"de küçük hatalar sesli anlatılmaz, sadece ekranda gösterilir.</p>
    </section>

    <section class="card">
      <label class="switch">
        <span style="display:flex; flex-direction:column; gap:2px">
          <span style="font-size:15px; font-weight:700">Seviyeyi otomatik ayarla</span>
          <span class="small">Şu an: ${esc(state.profile.level)} · her 20 cümlede güncellenir</span>
        </span>
        <input type="checkbox" id="autoLevel" ${s.autoLevel ? 'checked' : ''}>
      </label>
    </section>

    <section class="card">
      <h2>Tahmini harcama</h2>
      <div class="grid-3" id="costBox"></div>
      <p class="small">Yaklaşık değerlerdir. Kesin tutar OpenAI panelindedir.</p>
    </section>

    <section class="card">
      <h2>Veri</h2>
      <p class="small">Tüm bilgilerin bu telefonun tarayıcısında saklanır. Arada bir yedek almanı öneririm.</p>
      <button type="button" class="btn" id="exportBtn">Yedeği dışa aktar</button>
      <label class="btn" style="cursor:pointer">
        Yedeği içe aktar
        <input type="file" id="importFile" accept="application/json,.json" class="sr-only">
      </label>
      <button type="button" class="btn btn-danger" id="resetAll">Tüm verileri sıfırla</button>
    </section>

    <p class="small" style="text-align:center">İngilizce Öğretmen · v1.2</p>
  </div>`;

  const persist = () => saveSettings(state.settings);

  loadCosts().then((c) => {
    const month = today().slice(0, 7);
    const monthSum = Object.entries(c.days).filter(([d]) => d.startsWith(month)).reduce((a, [, v]) => a + v, 0);
    const box = app.querySelector('#costBox');
    if (box) box.innerHTML = [['Bugün', c.days[today()] || 0], ['Bu ay', monthSum], ['Toplam', c.total]]
      .map(([l, v]) => `<div class="stat" style="background:var(--bg)"><b style="font-size:17px">$${v.toFixed(2)}</b><span>${l}</span></div>`).join('');
  });

  const keyInput = app.querySelector('#apiKey');
  keyInput.addEventListener('change', async () => {
    s.apiKey = keyInput.value.trim();
    await persist();
  });
  app.querySelector('#toggleKey').addEventListener('click', (e) => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Gizle' : 'Göster';
  });
  app.querySelector('#testKey').addEventListener('click', async (e) => {
    s.apiKey = keyInput.value.trim();
    await persist();
    const out = app.querySelector('#keyResult');
    e.target.disabled = true;
    out.className = 'small';
    out.textContent = 'Test ediliyor…';
    const r = await testApiKey(s.apiKey);
    out.className = r.ok ? 'ok' : 'err';
    out.textContent = r.message;
    e.target.disabled = false;
  });

  app.querySelectorAll('input[name="voiceMode"]').forEach((r) =>
    r.addEventListener('change', async () => {
      s.voiceMode = r.value;
      await persist();
      toast(r.value === 'realtime' ? 'Canlı Sohbet seçildi.' : 'Bas-Konuş seçildi.');
    })
  );

  app.querySelectorAll('[data-seg]').forEach((b) =>
    b.addEventListener('click', async () => {
      const key = b.dataset.seg;
      s[key] = b.dataset.val;
      app.querySelectorAll(`[data-seg="${key}"]`).forEach((x) => x.setAttribute('aria-pressed', x === b));
      await persist();
    })
  );

  app.querySelectorAll('[data-model]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      s.models[inp.dataset.model] = inp.value.trim();
      await persist();
      toast('Model adı kaydedildi.');
    })
  );
  app.querySelector('#resetModels').addEventListener('click', async () => {
    const { DEFAULT_SETTINGS } = await import('./db.js');
    s.models = { ...DEFAULT_SETTINGS.models };
    await persist();
    renderSettings();
    toast('Varsayılan model adları geri yüklendi.');
  });

  app.querySelector('#voice').addEventListener('change', async (e) => {
    s.voice = e.target.value;
    await persist();
  });
  app.querySelector('#previewVoice').addEventListener('click', async (e) => {
    if (!s.apiKey) { toast('Önce API anahtarını gir.'); return; }
    e.target.disabled = true;
    try { await previewVoice(s, state.profile.level); }
    catch (err) { toast(err.message); }
    e.target.disabled = false;
  });
  app.querySelector('#autoLevel').addEventListener('change', async (e) => {
    s.autoLevel = e.target.checked;
    await persist();
  });

  app.querySelector('#exportBtn').addEventListener('click', async () => {
    const data = await exportAll();
    // API anahtarını yedeğe koyma (güvenlik)
    if (data.data.settings) data.data.settings = { ...data.data.settings, apiKey: '' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ingilizce-yedek-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Yedek indirildi (API anahtarı hariç).');
  });

  app.querySelector('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Mevcut verilerin yerine yedekteki veriler yüklenecek. Devam edilsin mi?')) return;
    try {
      const keepKey = state.settings.apiKey;
      await importAll(JSON.parse(await file.text()));
      await loadState();
      if (!state.settings.apiKey && keepKey) {
        state.settings.apiKey = keepKey;
        await saveSettings(state.settings);
      }
      toast('Yedek yüklendi.');
      renderSettings();
    } catch (err) {
      toast('Yüklenemedi: ' + err.message);
    }
  });

  app.querySelector('#resetAll').addEventListener('click', async () => {
    if (!confirm('Seviyen, çalışmaların ve tüm kayıtların silinecek. Emin misin?')) return;
    if (!confirm('Bu işlem geri alınamaz. Son kez soruyorum: silinsin mi?')) return;
    await db.clear();
    await loadState();
    toast('Tüm veriler silindi.');
    renderSettings();
  });
}

// ---------- Başlangıç ----------
async function loadState() {
  state.settings = await loadSettings();
  state.profile = await loadProfile();
  state.study = await loadStudy();
  state.savedStudies = await loadSavedStudies();
}

async function start() {
  await loadState();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();

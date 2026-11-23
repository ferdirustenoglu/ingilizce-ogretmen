// Ekranlar: ana sayfa, müfredat, kural kartı, hata defteri, ayarlar

import { db, saveSettings, loadCosts, today, exportAll, importAll } from './db.js';
import { testConnection, speak, hasKey, canSpeak, activeModel } from './ai.js';
import { PATTERNS, UNITS, patternById, patternsOfUnit, LEVELS } from './curriculum.js';
import { mistakeLabel } from './rules.js';
import {
  loadProfile, saveProfile, loadMastery, masteryOf, nextPattern,
  loadReviews, dueReviews, loadMistakes, clearMistakeType, loadStats, streak,
} from './learn.js';
import { startSession, activeSessionInfo, resetPracticeCache } from './practice.js';
import { esc, toast, IC, header, patternChips, bar } from './ui.js';

// ---------- Ana sayfa ----------
export async function renderHome(ctx) {
  const { app, state } = ctx;
  const [profile, mastery, reviews, stats, active, costs] = await Promise.all([
    loadProfile(), loadMastery(), loadReviews(), loadStats(), activeSessionInfo(), loadCosts(),
  ]);
  const due = dueReviews(reviews);
  const learned = PATTERNS.filter((p) => masteryOf(mastery, p.id).learned).length;
  const np = nextPattern(mastery);
  const npm = np ? masteryOf(mastery, np.id) : null;
  const day = stats.days[today()] || { n: 0, first: 0 };
  const fresh = !profile.placementDone && !Object.keys(mastery).length;

  app.innerHTML = `
  <div class="page">
    <div class="row between top">
      <div><h1>Cümle Atölyesi</h1><p class="muted">Türkçe cümleyi oku, İngilizcesini yaz.</p></div>
      <span class="badge">${esc(profile.level)}</span>
    </div>
    ${hasKey(state.settings) ? '' : '<div class="notice">Başlamak için <a href="#ayarlar">Ayarlar</a>’dan API anahtarını gir.</div>'}

    ${active ? `
    <section class="card accent">
      <div class="row between"><span class="cap">Yarım kalan çalışma</span><span class="small">${active.idx} / ${active.target}</span></div>
      <b>${esc(active.what)}</b>
      ${bar((active.idx / active.target) * 100)}
      <a class="btn btn-primary" href="#calis">Devam et</a>
    </section>` : ''}

    ${fresh ? `
    <section class="card accent">
      <b>Seviyeni bulalım</b>
      <p class="note">10 kısa cümleyle hangi üniteden başlaman gerektiğini bulur. Bildiğin kalıplar öğrenilmiş sayılır.</p>
      <button type="button" class="btn btn-primary" id="placement">Seviye testine başla</button>
      <button type="button" class="link-btn" id="skip">Testi atla, en baştan başla</button>
    </section>` : ''}

    ${due.length ? `
    <section class="card">
      <div class="row between"><b>${due.length} tekrar cümlen var</b><span class="small">1-3-7 gün tekrarı</span></div>
      <p class="note">Daha önce zorlandığın cümleler. Kısa sürer, kalıcı öğrenmenin anahtarı.</p>
      <button type="button" class="btn ${active || fresh ? '' : 'btn-primary'}" id="review">Tekrar et</button>
    </section>` : ''}

    ${np && !fresh ? `
    <section class="card">
      <div class="row between"><span class="cap">Sıradaki kalıp · ${np.unit}. ünite</span><span class="small">${esc(np.level)}</span></div>
      <b class="big">${esc(np.title)}</b>
      ${patternChips(np)}
      <div class="row between small"><span>Ustalık</span><span>${npm.score}/100</span></div>
      ${bar(npm.score)}
      <div class="row">
        <a class="btn grow" href="#kart/${np.id}">Kartı oku</a>
        <button type="button" class="btn btn-primary grow" id="learn">Çalış</button>
      </div>
    </section>` : ''}
    ${!np ? '<section class="card"><b>Tüm kalıpları öğrendin!</b><p class="note">Tekrarlar ve hata defteriyle devam edebilirsin.</p></section>' : ''}

    <section class="card">
      <div class="row between"><span class="cap">Genel ilerleme</span><span class="small">${learned} / ${PATTERNS.length} kalıp</span></div>
      ${bar((learned / PATTERNS.length) * 100)}
    </section>

    <div class="grid3">
      <div class="stat"><b>${day.n}</b><span>bugün cümle</span></div>
      <div class="stat"><b class="t-green">${day.n ? '%' + Math.round((day.first / day.n) * 100) : '–'}</b><span>ilk denemede</span></div>
      <div class="stat"><b class="t-amber">${streak(stats)}</b><span>gün seri</span></div>
    </div>
    <p class="small center">Bugünkü harcama: $${(costs.days[today()] || 0).toFixed(2)} · Model: ${esc(activeModel(state.settings))}</p>
  </div>`;

  const on = (id, fn) => app.querySelector(id)?.addEventListener('click', fn);
  on('#placement', () => startSession(ctx, { mode: 'placement' }));
  on('#skip', async () => { profile.placementDone = true; profile.level = 'A1'; await saveProfile(profile); renderHome(ctx); });
  on('#review', () => startSession(ctx, { mode: 'review' }));
  on('#learn', () => startSession(ctx, { mode: 'learn', pid: np.id }));
}

// ---------- Müfredat ----------
const openUnits = new Set();
export async function renderMap(ctx) {
  const { app } = ctx;
  const mastery = await loadMastery();
  const np = nextPattern(mastery);
  if (!openUnits.size && np) openUnits.add(np.unit);
  app.innerHTML = `
  <div class="page">
    <div><h1>Müfredat</h1><p class="muted">10 ünite, ${PATTERNS.length} kalıp. Bir kalıba dokun, kartını aç.</p></div>
    <div class="col" id="units">
      ${UNITS.map((u) => {
        const ps = patternsOfUnit(u.n);
        const done = ps.filter((p) => masteryOf(mastery, p.id).learned).length;
        const open = openUnits.has(u.n);
        return `<div class="unit">
          <button type="button" class="unit-head" data-unit="${u.n}" aria-expanded="${open}">
            <span class="unit-n${done === ps.length ? ' done' : ''}">${done === ps.length ? IC.check : u.n}</span>
            <span class="grow left"><b>${esc(u.title)}</b><span class="small">${done} / ${ps.length} öğrenildi</span></span>
            <span class="chev">${IC.chev}</span>
          </button>
          ${open ? ps.map((p) => {
            const m = masteryOf(mastery, p.id);
            return `<a class="prow${np && np.id === p.id ? ' next' : ''}" href="#kart/${p.id}">
              <span class="grow col tiny-gap"><span class="row between"><b>${esc(p.title)}</b><span class="small">${esc(p.level)}</span></span>
              ${patternChips(p)}${m.seen ? bar(m.score, 'thin' + (m.learned ? ' done' : '')) : ''}</span>
              ${m.learned ? `<span class="t-green">${IC.check}</span>` : ''}
            </a>`;
          }).join('') : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
  app.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    const n = +b.dataset.unit;
    if (openUnits.has(n)) openUnits.delete(n); else openUnits.add(n);
    renderMap(ctx);
  }));
}

// ---------- Kural kartı ----------
export async function renderCard(ctx, id) {
  const { app, state } = ctx;
  const p = patternById(id);
  if (!p) { location.hash = '#harita'; return; }
  const m = masteryOf(await loadMastery(), p.id);
  const unit = UNITS.find((u) => u.n === p.unit);
  const speakOk = canSpeak(state.settings);
  app.innerHTML = `
  <div class="page">
    ${header({ back: '#harita', title: `<span class="small">${p.unit}. ünite · ${esc(unit.title)} · ${esc(p.level)}</span><h1>${esc(p.title)}</h1>` })}
    ${patternChips(p)}
    <p class="lead">${esc(p.explain)}</p>
    <section class="card"><span class="cap">Kalıp</span><p class="formula">${esc(p.formula)}</p></section>
    <section class="card list">
      ${p.examples.map((e) => `<div class="ex">
        <span class="small">${esc(e.tr)}</span>
        <span class="row between"><b>${esc(e.en)}</b>${speakOk ? `<button type="button" class="icon-btn" data-say="${esc(e.en)}" aria-label="Dinle">${IC.speaker}</button>` : ''}</span>
      </div>`).join('')}
    </section>
    <section class="card warn">
      <span class="cap">Sık yapılan hata</span>
      <p><span class="t-red">✗ ${esc(p.mistake.wrong)}</span><br><span class="t-green">✓ ${esc(p.mistake.right)}</span></p>
      <p class="note">${esc(p.mistake.note)}</p>
    </section>
    ${m.seen ? `<section class="card"><div class="row between"><span class="cap">Ustalık</span><b>${m.score}/100${m.learned ? ' · öğrenildi' : ''}</b></div>${bar(m.score)}</section>` : ''}
    <button type="button" class="btn btn-primary" id="go">Çalışmaya başla (8 cümle)</button>
  </div>`;
  app.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', async () => {
    try { await speak(state.settings, b.dataset.say); } catch (e) { toast(e.message); }
  }));
  app.querySelector('#go').addEventListener('click', () => startSession(ctx, { mode: 'learn', pid: p.id }));
}

// ---------- Hata defteri ----------
export async function renderMistakes(ctx) {
  const { app } = ctx;
  const all = await loadMistakes();
  const types = Object.entries(all).sort((a, b) => b[1].count - a[1].count);
  app.innerHTML = `
  <div class="page">
    <div><h1>Hata Defteri</h1><p class="muted">Yaptığın hatalar türlerine göre. Bir türe özel çalışma başlatabilirsin.</p></div>
    ${types.length ? types.map(([t, x]) => `
    <section class="card">
      <div class="row between"><b>${esc(mistakeLabel(t))}</b><span class="count">${x.count} kez</span></div>
      ${x.rules.length ? `<p class="note">${esc(x.rules[0])}</p>` : ''}
      <div class="col tiny-gap">${x.examples.slice(0, 3).map((e) => `<div class="corr"><span class="small">${esc(e.tr)}</span><span><span class="t-red">${esc(e.wrong)}</span> → <span class="t-green">${esc(e.right)}</span></span></div>`).join('')}</div>
      <div class="row">
        <button type="button" class="btn btn-primary grow" data-practice="${t}">Bu hatayı çalış (6 cümle)</button>
        <button type="button" class="btn" data-clear="${t}" aria-label="${esc(mistakeLabel(t))} kaydını sil">Sil</button>
      </div>
    </section>`).join('') : '<section class="card center"><p>Henüz hata kaydı yok.</p><p class="small">Çalıştıkça yanlış yaptığın konular burada birikir.</p></section>'}
  </div>`;
  app.querySelectorAll('[data-practice]').forEach((b) => b.addEventListener('click', () => startSession(ctx, { mode: 'mistake', type: b.dataset.practice })));
  app.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Bu hata türünün kaydı silinsin mi?')) return;
    await clearMistakeType(b.dataset.clear);
    renderMistakes(ctx);
  }));
}

// ---------- Ayarlar ----------
export async function renderSettings(ctx) {
  const { app, state } = ctx;
  const s = state.settings;
  const profile = await loadProfile();
  const costs = await loadCosts();
  const month = today().slice(0, 7);
  const monthCost = Object.entries(costs.days).filter(([d]) => d.startsWith(month)).reduce((a, [, v]) => a + v, 0);
  app.innerHTML = `
  <div class="page">
    <h1>Ayarlar</h1>

    <section class="card">
      <span class="cap">Yapay zekâ</span>
      <div class="seg" role="group" aria-label="Sağlayıcı">
        <button type="button" data-prov="openai" aria-pressed="${s.provider === 'openai'}">OpenAI</button>
        <button type="button" data-prov="anthropic" aria-pressed="${s.provider === 'anthropic'}">Anthropic (Claude)</button>
      </div>
      <div id="provBox"></div>
      <button type="button" class="btn" id="test">Bağlantıyı test et</button>
      <p class="small" id="testMsg"></p>
    </section>

    <section class="card">
      <span class="cap">Seviye</span>
      <label class="field"><span>Cümle zorluğu (en az)</span>
        <select id="level" class="input">${LEVELS.map((l) => `<option ${l === profile.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <p class="small">Cümleler bu seviyeden ya da çalışılan kalıbın seviyesinden (hangisi yüksekse) üretilir.</p>
    </section>

    <section class="card">
      <span class="cap">Ses (örnekleri dinlemek için, OpenAI anahtarı gerekir)</span>
      <label class="field"><span>Ses</span>
        <select id="voice" class="input">${['marin', 'cedar', 'alloy', 'coral', 'sage', 'verse'].map((v) => `<option ${v === s.voice ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </label>
    </section>

    <section class="card">
      <span class="cap">Harcama (tahmini)</span>
      <div class="grid3">
        <div class="stat"><b>$${(costs.days[today()] || 0).toFixed(2)}</b><span>bugün</span></div>
        <div class="stat"><b>$${monthCost.toFixed(2)}</b><span>bu ay</span></div>
        <div class="stat"><b>$${costs.total.toFixed(2)}</b><span>toplam</span></div>
      </div>
      <p class="small">Gerçek fatura sağlayıcının panelindedir.</p>
    </section>

    <section class="card">
      <span class="cap">Veriler</span>
      <div class="row">
        <button type="button" class="btn grow" id="export">Yedek al</button>
        <label class="btn grow">Yedek yükle<input type="file" id="import" accept="application/json" hidden></label>
      </div>
      <button type="button" class="btn danger" id="reset">Tüm ilerlemeyi sıfırla</button>
      <p class="small">API anahtarları yedeğe yazılmaz ve sıfırlamada silinmez.</p>
    </section>
    <p class="small center">Cümle Atölyesi · v2.0</p>
  </div>`;

  const $ = (q) => app.querySelector(q);
  const save = async () => { await saveSettings(s); };
  const drawProv = () => {
    const ai = s.provider === 'anthropic';
    $('#provBox').innerHTML = ai ? `
      <label class="field"><span>Anthropic API anahtarı</span><input id="key" class="input" type="password" autocomplete="off" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…"></label>
      <label class="field"><span>Model</span><input id="model" class="input" value="${esc(s.anthropicModel)}"></label>
      <p class="small">Önerilen: claude-sonnet-5-5. Örnekleri dinlemek için ayrıca OpenAI anahtarı gerekir:</p>
      <label class="field"><span>OpenAI API anahtarı (ses için, isteğe bağlı)</span><input id="key2" class="input" type="password" autocomplete="off" value="${esc(s.openaiKey)}" placeholder="sk-…"></label>` : `
      <label class="field"><span>OpenAI API anahtarı</span><input id="key" class="input" type="password" autocomplete="off" value="${esc(s.openaiKey)}" placeholder="sk-…"></label>
      <label class="field"><span>Model</span><input id="model" class="input" value="${esc(s.openaiModel)}"></label>
      <p class="small">Önerilen: gpt-5.6-terra (iyi kalite, makul fiyat). Daha güçlüsü: gpt-5.6-sol.</p>`;
    $('#key').addEventListener('change', (e) => { s[ai ? 'anthropicKey' : 'openaiKey'] = e.target.value.trim(); save(); });
    $('#model').addEventListener('change', (e) => { s[ai ? 'anthropicModel' : 'openaiModel'] = e.target.value.trim() || (ai ? 'claude-sonnet-5-5' : 'gpt-5.6-terra'); save(); });
    $('#key2')?.addEventListener('change', (e) => { s.openaiKey = e.target.value.trim(); save(); });
  };
  drawProv();
  app.querySelectorAll('[data-prov]').forEach((b) => b.addEventListener('click', () => {
    s.provider = b.dataset.prov;
    app.querySelectorAll('[data-prov]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    save();
    drawProv();
  }));
  $('#test').addEventListener('click', async () => {
    document.activeElement?.blur();
    await save();
    $('#testMsg').textContent = 'Deneniyor…';
    const r = await testConnection(s);
    $('#testMsg').textContent = r.message;
    $('#testMsg').className = r.ok ? 'small t-green' : 'small t-red';
  });
  $('#level').addEventListener('change', async (e) => { profile.level = e.target.value; await saveProfile(profile); toast('Seviye kaydedildi.'); });
  $('#voice').addEventListener('change', (e) => { s.voice = e.target.value; save(); });
  $('#export').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify(await exportAll(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cumle-atolyesi-yedek-' + today() + '.json';
    a.click();
  });
  $('#import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await importAll(JSON.parse(await f.text()));
      resetPracticeCache();
      await ctx.reload();
      toast('Yedek yüklendi.');
      renderSettings(ctx);
    } catch (err) { toast(err.message); }
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Tüm ilerleme, tekrarlar ve hata defteri silinecek. Emin misin?')) return;
    const keep = { ...s };
    await db.clear();
    await saveSettings(keep);
    resetPracticeCache();
    await ctx.reload();
    toast('Sıfırlandı.');
    location.hash = '#home';
  });
}

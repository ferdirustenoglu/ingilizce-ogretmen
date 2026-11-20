// İlerleme ekranı: seviye geçmişi, Hata Bankası, kelime arşivi, geçmiş dersler
import { db } from './db.js';
import { LEVELS } from './topics.js';
import { loadMistakes, saveMistakes, loadWordArchive, mistakeTypeLabel, RULES, explainMistake } from './analysis.js';
import { speak } from './openai.js';
import { ttsInstructions, playbackRate } from './teacher.js';

const openLessons = new Set();
const loadingLessons = new Set();
let player = null;

const SPK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';

function lessonHtml(m, esc) {
  const L = m.lesson;
  if (!L) {
    return loadingLessons.has(m.id)
      ? '<p class="small">Konu anlatımı hazırlanıyor…</p>'
      : '<p class="small">Konu anlatımı henüz hazırlanmadı.</p>';
  }
  return `
    ${L.title ? `<h3 class="ml-title">${esc(L.title)}</h3>` : ''}
    ${L.explanation ? `<p class="ml-text">${esc(L.explanation)}</p>` : ''}
    ${L.pattern ? `<div class="ml-pattern"><span class="ml-label">Kalıp</span>${esc(L.pattern)}</div>` : ''}
    ${L.examples.length ? `<div class="ml-sec"><span class="ml-label">Örnekler</span>
      ${L.examples.map((e) => `<div class="ml-ex">
        <div style="flex:1; min-width:0"><p class="ml-en">${esc(e.en)}</p>${e.tr ? `<p class="ml-tr">${esc(e.tr)}</p>` : ''}</div>
        <button type="button" class="replay" data-say="${esc(e.en)}" aria-label="Örneği dinle">${SPK}</button>
      </div>`).join('')}</div>` : ''}
    ${L.wrongRight.length ? `<div class="ml-sec"><span class="ml-label">Yanlış → Doğru</span>
      ${L.wrongRight.map((w) => `<p class="ml-wr"><span class="ml-wrong">${esc(w.wrong)}</span> → <span class="ml-right">${esc(w.right)}</span></p>`).join('')}</div>` : ''}
    ${L.tip ? `<div class="ml-tip"><span class="ml-label" style="color:var(--amber)">İpucu</span>${esc(L.tip)}</div>` : ''}
    ${L.practice ? `<div class="ml-sec"><span class="ml-label">Kendini dene</span>
      <p class="ml-en">${esc(L.practice.q)}</p>
      <details class="ml-ans"><summary>Örnek cevabı göster</summary><p class="ml-right" style="margin-top:6px">${esc(L.practice.a)}</p></details>
      <p class="small">İpucu: Bu soruyu bir sonraki derste öğretmene de cevaplayabilirsin.</p></div>` : ''}
    <button type="button" class="link-btn" data-regen="${m.id}">Anlatımı yeniden hazırla</button>`;
}


let tab = 'mistakes';
let mFilter = 'active';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) : '');
const fmtDay = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) : '');

export async function renderProgress(c, sub) {
  const { app, state, esc } = c;
  if (sub === 'lessons') tab = 'lessons';
  const profile = state.profile;
  const mistakes = await loadMistakes();
  const words = await loadWordArchive();
  const lessons = (await db.get('lessons')) || [];
  const active = mistakes.filter((m) => m.status === 'active');
  const learned = mistakes.filter((m) => m.status === 'learned');

  app.innerHTML = `
  <div class="page">
    <h1>İlerleme</h1>

    <section class="card">
      <div class="row-between"><h2>Seviye geçmişi</h2><span class="small">Şu an: <b style="color:var(--text)">${esc(profile.level)}</b></span></div>
      ${levelChart(profile)}
      <p class="small">${profile.placementDone ? `Son 20 cümle ortalaması: ${profile.lastWindowAvg ?? '–'}` : `Seviye belirleniyor (${profile.analyzedCount || 0} / ${RULES.placementTotal} cümle)`} · Toplam ${profile.sentenceCount || 0} cümle</p>
    </section>

    <div class="tabs" role="tablist" aria-label="İlerleme bölümleri">
      <button type="button" role="tab" data-tab="mistakes" aria-selected="${tab === 'mistakes'}">Hata Bankası</button>
      <button type="button" role="tab" data-tab="words" aria-selected="${tab === 'words'}">Kelimeler</button>
      <button type="button" role="tab" data-tab="lessons" aria-selected="${tab === 'lessons'}">Dersler</button>
    </div>

    <div id="tabBody" style="display:flex; flex-direction:column; gap:12px"></div>
  </div>`;

  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    renderProgress(c);
  }));

  const body = app.querySelector('#tabBody');

  if (tab === 'mistakes') {
    const list = mFilter === 'active' ? active : learned;
    list.sort((a, b) => (mFilter === 'active' ? b.count - a.count : String(b.learnedAt).localeCompare(String(a.learnedAt))));
    body.innerHTML = `
      <div class="row" style="gap:8px">
        <button type="button" class="pill-filter" data-mf="active" aria-pressed="${mFilter === 'active'}">Aktif (${active.length})</button>
        <button type="button" class="pill-filter" data-mf="learned" aria-pressed="${mFilter === 'learned'}">Öğrenildi (${learned.length})</button>
      </div>
      ${list.length ? list.map((m) => `
        <article class="card" style="gap:8px">
          <div class="row-between">
            <span class="type-tag">${esc(mistakeTypeLabel(m.type))}</span>
            <span class="small">${m.count} kez yapıldı</span>
          </div>
          <p style="font-size:14px; line-height:1.45"><span style="color:#D9BC83; text-decoration:line-through">${esc(m.original)}</span> → <span style="font-weight:700; color:#FFE2A8">${esc(m.corrected)}</span></p>
          ${m.rule_tr ? `<p class="small">${esc(m.rule_tr)}</p>` : ''}
          <button type="button" class="ml-toggle" data-open="${m.id}" aria-expanded="${openLessons.has(m.id)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/></svg>
            <span style="flex:1; text-align:left">Konu anlatımı ve örnekler</span>
            <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </button>
          ${openLessons.has(m.id) ? `<div class="mlesson">${lessonHtml(m, esc)}</div>` : ''}
          <div class="row-between">
            <div class="dots">${[0, 1, 2].map((i) => `<i class="${i < m.correctLessons.length ? 'on' : ''}"></i>`).join('')}<span>${Math.min(m.correctLessons.length, 3)} / ${RULES.learnedAfter} doğru kullanım</span></div>
            <div class="row" style="gap:6px">
              ${m.status === 'active' ? `<button type="button" class="btn btn-small" data-learn="${m.id}" style="min-height:36px; padding:0 10px; font-size:12px">Öğrendim</button>` : ''}
              <button type="button" class="btn btn-small btn-danger" data-delm="${m.id}" aria-label="Bu hatayı sil" style="min-height:36px; padding:0 10px; font-size:12px">Sil</button>
            </div>
          </div>
        </article>`).join('') : `<p class="muted">${mFilter === 'active' ? 'Aktif hata yok. Konuştukça yaptığın hatalar burada birikir.' : 'Henüz öğrenilen hata yok. Bir hatayı 3 farklı derste doğru kullanınca buraya geçer.'}</p>`}`;

    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.open;
      if (openLessons.has(id)) { openLessons.delete(id); renderProgress(c); return; }
      openLessons.add(id);
      const m = list.find((x) => x.id === id);
      if (m && !m.lesson) await makeLesson(c, id);
      else renderProgress(c);
    }));
    body.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', () => makeLesson(c, b.dataset.regen)));
    body.querySelectorAll('[data-say]').forEach((b) => b.addEventListener('click', () => sayText(c, b.dataset.say, b)));
    body.querySelectorAll('[data-mf]').forEach((b) => b.addEventListener('click', () => { mFilter = b.dataset.mf; renderProgress(c); }));
    body.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', async () => {
      const all = await loadMistakes();
      const m = all.find((x) => x.id === b.dataset.learn);
      if (m) { m.status = 'learned'; m.learnedAt = new Date().toISOString(); await saveMistakes(all); }
      renderProgress(c);
    }));
    body.querySelectorAll('[data-delm]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Bu hata kaydı silinsin mi?')) return;
      const all = (await loadMistakes()).filter((x) => x.id !== b.dataset.delm);
      await saveMistakes(all);
      renderProgress(c);
    }));
  }

  if (tab === 'words') {
    const entries = Object.entries(words).sort((a, b) => String(b[1].firstAt).localeCompare(String(a[1].firstAt)));
    body.innerHTML = entries.length ? `
      <section class="card" style="padding:4px 16px">
        ${entries.map(([w, v]) => {
          const done = v.stage >= RULES.reviewDays.length;
          const st = done ? '<span style="color:var(--green); font-weight:700">Öğrenildi</span>'
            : v.nextReview ? `Tekrar: ${fmtDay(v.nextReview)}` : (v.okCount ? '' : 'Henüz kullanılmadı');
          return `<div class="list-row">
            <div style="display:flex; flex-direction:column; gap:2px">
              <span style="font-size:15px; font-weight:600">${esc(w)}</span>
              <span class="small">${fmtDay(v.firstAt)} eklendi · ${v.okCount} doğru${v.badCount ? ` · ${v.badCount} hatalı` : ''}</span>
            </div>
            <span class="small" style="text-align:right">${st}</span>
          </div>`;
        }).join('')}
      </section>
      <p class="small">Doğru kullandığın kelimeler 1, 3, 7 ve 14 gün sonra derslerde tekrar karşına çıkar.</p>`
      : '<p class="muted">Henüz kelime yok. Çalışma ekranından kelime ekleyip ders yaptığında burada görünür.</p>';
  }

  if (tab === 'lessons') {
    body.innerHTML = lessons.length ? `
      <section class="card" style="padding:4px 16px">
        ${lessons.map((l) => {
          const n = l.messages.filter((m) => m.role === 'student').length;
          return `<a class="list-row" href="#summary/${l.id}">
            <div style="display:flex; flex-direction:column; gap:2px">
              <span style="font-size:15px; font-weight:600">${fmt(l.startedAt)} · ${l.mode === 'live' ? 'Canlı Sohbet' : 'Bas-Konuş'}</span>
              <span class="small">${n} cümle · ${esc(l.levelStart || '')}${l.levelEnd && l.levelEnd !== l.levelStart ? ' → ' + esc(l.levelEnd) : ''} · $${(l.cost || 0).toFixed(2)}</span>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9AA3CF" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </a>`;
        }).join('')}
      </section>`
      : '<p class="muted">Henüz biten ders yok. Bir dersi "Dersi Bitir" ile kapattığında burada görünür.</p>';
  }
}

// Basamaklı seviye grafiği (SVG)
function levelChart(profile) {
  const hist = (profile.levelHistory || []).filter((h) => h.level);
  const pts = hist.slice(-12);
  if (pts.length < 2) {
    return '<p class="muted" style="font-size:13px">Seviyen değiştikçe grafik burada oluşur.</p>';
  }
  const idx = pts.map((p) => LEVELS.indexOf(p.level));
  const lo = Math.max(0, Math.min(...idx) - 1);
  const hi = Math.min(LEVELS.length - 1, Math.max(...idx) + 1);
  const W = 320; const H = 130; const left = 38; const top = 10; const bottom = 112;
  const y = (i) => bottom - ((i - lo) / Math.max(1, hi - lo)) * (bottom - top);
  const x = (k) => left + (k / (pts.length - 1)) * (W - left - 8);
  let d = `M${x(0)} ${y(idx[0])}`;
  for (let k = 1; k < pts.length; k++) d += ` H${x(k)} V${y(idx[k])}`;
  const labels = [];
  for (let i = lo; i <= hi; i++) labels.push(i);
  const step = labels.length > 6 ? 2 : 1;
  const label = `Seviye ${LEVELS[idx[0]]} seviyesinden ${LEVELS[idx[idx.length - 1]]} seviyesine`;
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    ${labels.filter((_, k) => k % step === 0).map((i) => `<line x1="${left}" y1="${y(i)}" x2="${W}" y2="${y(i)}" stroke="#2A3463"/><text x="0" y="${y(i) + 4}" fill="#9AA3CF" font-size="11" font-weight="600" font-family="Inter, sans-serif">${LEVELS[i]}</text>`).join('')}
    <path d="${d}" fill="none" stroke="#7C8CFF" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(idx[idx.length - 1])}" r="5" fill="#3DD68C"/>
  </svg>`;
}

async function makeLesson(c, id) {
  const { state, toast } = c;
  if (!state.settings.apiKey) { toast('Önce Ayarlar’dan API anahtarını gir.'); renderProgress(c); return; }
  if (loadingLessons.has(id)) return;
  loadingLessons.add(id);
  // Yeniden hazırlarken eski anlatımı gizle
  const all = await loadMistakes();
  const m = all.find((x) => x.id === id);
  if (m && m.lesson) { delete m.lesson; await saveMistakes(all); }
  renderProgress(c);
  try {
    await explainMistake(state.settings, id, state.profile.level);
  } catch (e) {
    toast(e.message);
  }
  loadingLessons.delete(id);
  if (location.hash.startsWith('#progress')) renderProgress(c);
}

async function sayText(c, text, btn) {
  const { state, toast } = c;
  if (!state.settings.apiKey) { toast('Önce Ayarlar’dan API anahtarını gir.'); return; }
  if (player) { player.pause(); player = null; }
  btn.disabled = true;
  try {
    const blob = await speak(state.settings, text, ttsInstructions(state.settings, state.profile.level));
    player = new Audio(URL.createObjectURL(blob));
    player.preservesPitch = true;
    player.playbackRate = playbackRate(state.settings, state.profile.level);
    await player.play();
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
}

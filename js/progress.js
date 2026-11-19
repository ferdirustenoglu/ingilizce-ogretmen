// İlerleme ekranı: seviye geçmişi, Hata Bankası, kelime arşivi, geçmiş dersler
import { db } from './db.js';
import { LEVELS } from './topics.js';
import { loadMistakes, saveMistakes, loadWordArchive, mistakeTypeLabel, RULES } from './analysis.js';

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
          <div class="row-between">
            <div class="dots">${[0, 1, 2].map((i) => `<i class="${i < m.correctLessons.length ? 'on' : ''}"></i>`).join('')}<span>${Math.min(m.correctLessons.length, 3)} / ${RULES.learnedAfter} doğru kullanım</span></div>
            <div class="row" style="gap:6px">
              ${m.status === 'active' ? `<button type="button" class="btn btn-small" data-learn="${m.id}" style="min-height:36px; padding:0 10px; font-size:12px">Öğrendim</button>` : ''}
              <button type="button" class="btn btn-small btn-danger" data-delm="${m.id}" aria-label="Bu hatayı sil" style="min-height:36px; padding:0 10px; font-size:12px">Sil</button>
            </div>
          </div>
        </article>`).join('') : `<p class="muted">${mFilter === 'active' ? 'Aktif hata yok. Konuştukça yaptığın hatalar burada birikir.' : 'Henüz öğrenilen hata yok. Bir hatayı 3 farklı derste doğru kullanınca buraya geçer.'}</p>`}`;

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

// Ders sonu özeti
import { db, addCost } from './db.js';
import { LEVELS } from './topics.js';
import { textCost } from './openai.js';

const fmtDate = (iso) => new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
const minutes = (l) => Math.max(1, Math.round((new Date(l.endedAt || Date.now()) - new Date(l.startedAt)) / 60000));

export async function renderSummary({ app, state, esc, toast }, id) {
  const archive = (await db.get('lessons')) || [];
  const l = id ? archive.find((x) => String(x.id) === String(id)) : archive[0];
  if (!l) {
    app.innerHTML = '<div class="page"><h1>Ders Özeti</h1><p class="muted">Bu ders bulunamadı.</p><a class="btn" href="#home">Ana Sayfa</a></div>';
    return;
  }

  const students = l.messages.filter((m) => m.role === 'student' && m.text);
  const scored = students.filter((m) => m.scores);
  const avg = (k) => (scored.length ? Math.round(scored.reduce((a, m) => a + (m.scores[k] || 0), 0) / scored.length) : null);
  const sc = { accuracy: avg('accuracy'), vocabulary: avg('vocabulary'), complexity: avg('complexity'), naturalness: avg('naturalness'), avg: avg('avg') };
  const fixes = students.filter((m) => m.correction && m.correction.corrected);
  const words = l.words || [];
  const review = l.reviewWords || [];
  const ws = l.wordStatus || {};
  const okN = words.filter((w) => ws[w.toLowerCase()] === 'ok').length;
  const badN = words.filter((w) => ws[w.toLowerCase()] === 'bad').length;
  const from = l.levelStart || l.levelEnd;
  const to = l.levelEnd || from;
  const up = LEVELS.indexOf(to) > LEVELS.indexOf(from);
  const down = LEVELS.indexOf(to) < LEVELS.indexOf(from);
  const added = (l.mistakesAdded || []).length;
  const learned = (l.mistakesLearned || []).length;
  const isLatest = archive[0] && archive[0].id === l.id;

  app.innerHTML = `
  <div class="page">
    <div style="display:flex; flex-direction:column; gap:4px">
      <h1>Ders Özeti</h1>
      <p class="muted">${fmtDate(l.startedAt)} · ${minutes(l)} dk · ${students.length} cümle · ${l.mode === 'live' ? 'Canlı Sohbet' : 'Bas-Konuş'}</p>
    </div>

    <section class="card" style="flex-direction:row; align-items:center; gap:14px">
      ${from !== to ? `<span class="lvl-box">${esc(from)}</span>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${up ? '#3DD68C' : '#FFB547'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>` : ''}
      <span class="lvl-box now">${esc(to)}</span>
      <div style="flex:1; display:flex; flex-direction:column; gap:2px">
        <span style="font-size:14px; font-weight:700; color:${up ? 'var(--green)' : down ? 'var(--amber)' : 'var(--text)'}">${up ? 'Seviye atladın' : down ? 'Seviye ayarlandı' : 'Seviyen'}</span>
        <span class="small">${sc.avg !== null ? 'Ortalama puan ' + sc.avg : 'Puanlar hesaplanıyor'}</span>
      </div>
    </section>

    ${scored.length ? `<section class="score-grid" aria-label="Puan özeti">
      <div class="score"><b>${sc.accuracy}</b><span>Doğruluk</span></div>
      <div class="score"><b>${sc.vocabulary}</b><span>Kelime</span></div>
      <div class="score"><b>${sc.complexity}</b><span>Karmaşıklık</span></div>
      <div class="score"><b>${sc.naturalness}</b><span>Doğallık</span></div>
    </section>` : ''}

    <section class="card" id="tips">
      <h2>Öğretmenin notu</h2>
      <p class="muted" id="tipsBody">${l.tips ? '' : (state.settings.apiKey && students.length ? 'Hazırlanıyor…' : 'Not yok.')}</p>
    </section>

    <section class="card">
      <h2>Düzeltilen cümleler${fixes.length ? ` (${fixes.length})` : ''}</h2>
      ${fixes.length ? fixes.map((m) => `
        <div class="fix">
          <span class="old">${esc(m.correction.original || m.text)}</span>
          <span class="new">${esc(m.correction.corrected)}</span>
          ${m.correction.note_tr ? `<span class="why">${esc(m.correction.note_tr)}</span>` : ''}
        </div>`).join('') : '<p class="muted">Bu derste düzeltme gerekmedi. Harika!</p>'}
    </section>

    ${words.length || review.length ? `<section class="card">
      <div class="row-between"><h2>Kelimeler</h2><span class="small">${okN} doğru · ${badN} hatalı · ${words.length - okN - badN} kullanılmadı</span></div>
      <div class="chip-row" style="max-height:none">${[...words, ...review].map((w, i) => {
        const s = ws[w.toLowerCase()];
        const cls = (s === 'ok' ? 'chip chip-ok' : s === 'bad' ? 'chip chip-bad' : 'chip') + (i >= words.length && !s ? ' chip-review' : '');
        return `<span class="${cls}">${esc(w)}${s === 'ok' ? ' ✓' : s === 'bad' ? ' !' : ''}</span>`;
      }).join('')}</div>
    </section>` : ''}

    <section class="grid-3" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="stat"><span>Hata Bankası</span><b style="font-size:15px"><span style="color:var(--amber)">+${added}</span> yeni · <span style="color:var(--green)">${learned}</span> öğrenildi</b></div>
      <div class="stat"><span>Tahmini maliyet</span><b style="font-size:15px">$${(l.cost || 0).toFixed(3)}</b></div>
    </section>

    <div style="display:flex; flex-direction:column; gap:10px">
      ${isLatest ? '<a class="btn btn-primary btn-big" href="#lesson">Yeni Ders Başlat</a>' : ''}
      <a class="btn" href="${isLatest ? '#home' : '#progress/lessons'}">${isLatest ? 'Ana Sayfa' : 'Derslere dön'}</a>
    </div>
  </div>`;

  // Öğretmenin notu: yapay zekâdan kısa bir değerlendirme (bir kez üretilir, saklanır)
  const tipsBody = app.querySelector('#tipsBody');
  if (l.tips) {
    tipsBody.outerHTML = `<div style="display:flex; flex-direction:column; gap:8px">${l.tips.map((t) => `
      <div class="row" style="align-items:flex-start; gap:10px; font-size:14px; line-height:1.45">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${t.kind === 'tip' ? '#FFB547' : '#3DD68C'}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0; margin-top:2px">${t.kind === 'tip' ? '<path d="M12 8v5M12 16.5v.5"/>' : '<path d="M5 12l5 5 9-10"/>'}</svg>
        <span>${esc(t.text)}</span>
      </div>`).join('')}</div>`;
  } else if (state.settings.apiKey && students.length) {
    try {
      l.tips = await makeTips(state.settings, l, students, fixes);
      const all = (await db.get('lessons')) || [];
      const i = all.findIndex((x) => x.id === l.id);
      if (i >= 0) { all[i].tips = l.tips; await db.set('lessons', all); }
      if (location.hash.startsWith('#summary')) renderSummary({ app, state, esc, toast }, l.id);
    } catch {
      if (tipsBody) tipsBody.textContent = 'Not hazırlanamadı.';
    }
  }
}

async function makeTips(settings, l, students, fixes) {
  const model = settings.models.analysis;
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an English teacher writing a very short end-of-lesson note for an adult Turkish learner. Write in simple Turkish. Return ONLY JSON: {"good":["...","..."],"tip":"..."} — "good": 2 specific things the student did well in this lesson (max 15 words each), "tip": 1 concrete thing to work on next (max 20 words).',
      },
      {
        role: 'user',
        content: `Level: ${l.levelEnd}. Student sentences:\n${students.slice(-30).map((m) => '- ' + m.text).join('\n')}\nCorrections:\n${fixes.slice(-10).map((m) => `- ${m.correction.original} -> ${m.correction.corrected}`).join('\n') || '- none'}`,
      },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 500,
  };
  if (model.startsWith('gpt-5')) body.reasoning_effort = 'minimal';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('tips ' + res.status);
  const j = await res.json();
  await addCost(textCost(model, j.usage));
  const d = JSON.parse(j.choices?.[0]?.message?.content || '{}');
  return [...(d.good || []).slice(0, 2).map((t) => ({ kind: 'good', text: String(t) })), ...(d.tip ? [{ kind: 'tip', text: String(d.tip) }] : [])];
}

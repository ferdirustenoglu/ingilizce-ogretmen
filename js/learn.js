// Öğrenme motoru: cümle üretme, cevap kontrolü, ustalık puanı, tekrar, hata defteri, istatistik.

import { db, today } from './db.js';
import { askJSON } from './ai.js';
import { RULES, MISTAKE_TYPES } from './rules.js';
import { PATTERNS, patternById, LEVELS, levelIndex } from './curriculum.js';

export const ROLE_KEYS = ['S', 'AUX', 'V', 'OBJ', 'ADV', 'CONJ', 'X'];
export const ROLE_LABELS = { S: 'Özne', AUX: 'Yardımcı fiil', V: 'Fiil', OBJ: 'Nesne', ADV: 'Zarf', CONJ: 'Bağlaç', X: '' };
const roleKey = (r) => (ROLE_KEYS.includes(r) ? r : 'X');
const str = (v) => (v == null ? '' : String(v)).trim();

// ---------- Profil ----------
export async function loadProfile() {
  return { level: 'A2', placementDone: false, ...((await db.get('profile')) || {}) };
}
export const saveProfile = (p) => db.set('profile', p);

// ---------- Parça biçimi: "I/S | 'm/AUX | tired/V" ----------
export function parseParts(v, fallback) {
  let list = [];
  const one = (tok) => {
    const i = tok.lastIndexOf('/');
    if (i <= 0) return { t: tok.trim(), r: 'X', ok: true, hl: false };
    let r = tok.slice(i + 1).trim().toUpperCase();
    const bad = r.includes('!');
    const hl = r.includes('*');
    r = r.replace(/[!*\s]/g, '');
    return { t: tok.slice(0, i).trim(), r: roleKey(r), ok: !bad, hl };
  };
  if (typeof v === 'string') list = v.split('|').map((x) => x.trim()).filter(Boolean).map(one);
  else if (Array.isArray(v)) list = v.map((x) => (typeof x === 'string' ? one(x) : x && x.t ? { t: str(x.t), r: roleKey(str(x.r).toUpperCase()), ok: x.ok !== false, hl: !!x.hl } : null)).filter(Boolean);
  list = list.filter((x) => x.t);
  return list.length ? list : [{ t: fallback || '', r: 'X', ok: true, hl: false }];
}

// ---------- Cümle üretme ----------
// specs: [{ pid, form, focus? }]
export async function generateItems(settings, { level, specs, words = [], avoid = [] }) {
  const byPattern = {};
  specs.forEach((s) => { (byPattern[s.pid] = byPattern[s.pid] || []).push(s); });
  const lines = ['TASK: GENERATE', `Student level: ${level}`, `Number of items: ${specs.length}`, ''];
  Object.keys(byPattern).forEach((pid) => {
    const p = patternById(pid);
    lines.push(`PATTERN ${pid}: Turkish "${p.tr}" → English "${p.en}" (${p.title}, level ${p.level})`);
    lines.push(`Rule: ${p.explain}`);
    lines.push(`Formula: ${p.formula}`);
    lines.push('Model examples (style only, do not copy):');
    p.examples.forEach((e) => lines.push(`  "${e.tr}" → "${e.en}"`));
    lines.push('');
  });
  lines.push('ITEMS (in this order):');
  specs.forEach((s, i) => lines.push(`${i + 1}. pattern ${s.pid}; form: ${s.form}${s.focus ? '; also practise: ' + s.focus : ''}`));
  if (words.length) lines.push('', `Target words (use where natural, max two per sentence): ${words.join(', ')}`);
  if (avoid.length) lines.push('', `Do not repeat or closely imitate these sentences: ${avoid.slice(-30).join(' | ')}`);
  const { data } = await askJSON(settings, RULES, lines.join('\n'), { maxTokens: 2500 + specs.length * 1200, effort: 'medium' });
  const items = (Array.isArray(data.items) ? data.items : []).map((x, i) => normItem(x, specs[i])).filter(Boolean);
  if (!items.length) throw new Error('Cümleler hazırlanamadı. Tekrar dene.');
  return items;
}

function normItem(x, spec) {
  if (!x || !str(x.tr) || !str(x.answer) || !spec) return null;
  const tr = str(x.tr);
  const focus = str(x.tr_focus);
  return {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    pid: spec.pid,
    tr,
    trFocus: focus && tr.includes(focus) ? focus : '',
    answer: str(x.answer),
    parts: parseParts(x.parts, str(x.answer)),
    steps: (Array.isArray(x.steps) ? x.steps : []).filter((s) => s && (s.en || s.tr)).slice(0, 10)
      .map((s) => ({ r: roleKey(str(s.r).toUpperCase()), tr: str(s.tr), en: str(s.en), note: str(s.note) })),
    daily: str(x.daily) || str(x.answer),
    dailyNote: str(x.daily_note_tr),
    rule: str(x.rule_tr),
    words: (Array.isArray(x.words) ? x.words : []).filter((w) => w && w.tr && w.en)
      .map((w) => ({ tr: str(w.tr), en: str(w.en) })).filter((w) => w.tr.toLowerCase() !== w.en.toLowerCase()).slice(0, 4),
    // durum
    attempts: 0, hints: 0, draft: '', status: null, check: null, firstVerdict: null,
  };
}

// ---------- Cevap kontrolü ----------
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[’‘`´]/g, "'")
  .replace(/\b(i|you|we|they|he|she|it|that|there|what|who|where)'(m|re|ve|ll|d|s)\b/g, (m, a, b) => a + ' ' + ({ m: 'am', re: 'are', ve: 'have', ll: 'will', d: 'would', s: 'is' }[b]))
  .replace(/\b(do|does|did|is|are|was|were|have|has|had|could|would|should|must)n't\b/g, '$1 not')
  .replace(/\bcan't\b/g, 'cannot').replace(/\bwon't\b/g, 'will not').replace(/\bcan not\b/g, 'cannot')
  .replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

export const sameSentence = (a, b) => norm(a) === norm(b);

export async function checkAnswer(settings, level, item, text, words = []) {
  // Yerel ön kontrol: doğru cevap ya da günlük hâliyle aynıysa yapay zekâya sormaya gerek yok
  if (sameSentence(text, item.answer) || sameSentence(text, item.daily)) {
    const parts = sameSentence(text, item.answer) ? item.parts : [{ t: item.daily, r: 'X', ok: true, hl: false }];
    return {
      verdict: 'correct', local: true, summary: 'Tam isabet!', praise: '',
      userParts: parts.map((p) => ({ ...p, ok: true, hl: false })),
      fixed: text, fixedParts: parts.map((p) => ({ ...p, hl: false })),
      explain: [], also: null, mistake: null, wordsOk: [], wordsBad: [],
    };
  }
  const p = patternById(item.pid);
  const user = [
    'TASK: CHECK',
    `Student level: ${level}`,
    p ? `Pattern: ${p.tr} → ${p.en} (${p.title})` : '',
    `Turkish: "${item.tr}"`,
    `Reference answer: "${item.answer}"`,
    `Reference parts: ${item.parts.map((x) => x.t + '/' + x.r).join(' | ')}`,
    words.length ? `Target words: ${words.join(', ')}` : '',
    `Student wrote: "${text}"`,
  ].filter(Boolean).join('\n');
  const { data } = await askJSON(settings, RULES, user, { maxTokens: 2500, effort: 'low' });
  const verdict = ['correct', 'close', 'wrong'].includes(data.verdict) ? data.verdict : 'wrong';
  const fixed = str(data.fixed) || item.answer;
  const also = data.also && str(data.also.en) && !sameSentence(data.also.en, fixed) ? { en: str(data.also.en), note: str(data.also.note_tr) } : null;
  const mk = data.mistake && data.mistake.type ? {
    type: MISTAKE_TYPES[data.mistake.type] ? data.mistake.type : 'word_choice',
    key: str(data.mistake.key).toLowerCase(),
    rule: str(data.mistake.rule_tr),
  } : null;
  return {
    verdict,
    summary: str(data.summary_tr),
    praise: str(data.praise_tr),
    userParts: parseParts(data.user_parts, text),
    fixed,
    fixedParts: parseParts(data.fixed_parts, fixed),
    explain: (Array.isArray(data.explain) ? data.explain : []).filter((e) => e && (e.text || e.tag)).slice(0, 3)
      .map((e) => ({ type: MISTAKE_TYPES[e.type] ? e.type : '', tag: str(e.tag), text: str(e.text), example: str(e.example) })),
    also,
    mistake: verdict === 'correct' ? null : mk,
    wordsOk: (data.words_ok || []).map(String),
    wordsBad: (data.words_wrong || []).map(String),
  };
}

// ---------- Ustalık puanı ----------
export async function loadMastery() { return (await db.get('mastery')) || {}; }
const saveMastery = (m) => db.set('mastery', m);
export const masteryOf = (m, id) => m[id] || { score: 0, seen: 0, first: 0, learned: false };

// result: 'first' (ilk denemede doğru) | 'retry' (ipucu/2. deneme ile doğru) | 'close' | 'wrong' | 'shown'
const DELTA = { first: 12, retry: 5, close: -3, wrong: -8, shown: -8 };
export async function updateMastery(pid, result) {
  const m = await loadMastery();
  const x = masteryOf(m, pid);
  x.seen++;
  if (result === 'first') x.first++;
  x.score = Math.max(0, Math.min(100, x.score + (DELTA[result] || 0)));
  x.lastAt = new Date().toISOString();
  if (x.score >= 80 && !x.learned) { x.learned = true; x.learnedAt = x.lastAt; }
  if (x.score < 60 && x.learned) x.learned = false;
  m[pid] = x;
  await saveMastery(m);
  return x;
}
export async function setLearned(pids) {
  const m = await loadMastery();
  pids.forEach((pid) => { const x = masteryOf(m, pid); x.score = Math.max(x.score, 80); x.learned = true; m[pid] = x; });
  await saveMastery(m);
}

// Sıradaki önerilen kalıp: müfredat sırasında öğrenilmemiş ilk kalıp
export function nextPattern(mastery) {
  return PATTERNS.find((p) => !masteryOf(mastery, p.id).learned) || null;
}

// ---------- Tekrar (1, 3, 7 gün) ----------
const STEPS = [1, 3, 7];
export async function loadReviews() { return (await db.get('reviews')) || []; }
const saveReviews = (r) => db.set('reviews', r);

export async function addReview(item) {
  const list = await loadReviews();
  if (list.some((r) => r.tr === item.tr)) return;
  list.push({
    rid: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    pid: item.pid, tr: item.tr, trFocus: item.trFocus, answer: item.answer, parts: item.parts, steps: item.steps,
    daily: item.daily, dailyNote: item.dailyNote, rule: item.rule, words: item.words,
    stage: 0, due: today(STEPS[0]), addedAt: today(),
  });
  await saveReviews(list.slice(-300));
}
export async function reviewDone(rid, ok) {
  const list = await loadReviews();
  const r = list.find((x) => x.rid === rid);
  if (!r) return;
  if (ok) {
    r.stage++;
    if (r.stage >= STEPS.length) list.splice(list.indexOf(r), 1);
    else r.due = today(STEPS[r.stage]);
  } else {
    r.stage = 0;
    r.due = today(STEPS[0]);
  }
  await saveReviews(list);
}
export const dueReviews = (list) => list.filter((r) => r.due <= today());

// ---------- Hata defteri ----------
export async function loadMistakes() { return (await db.get('mistakes')) || {}; }
export async function recordMistake(mk, item, text, fixed) {
  if (!mk) return;
  const all = await loadMistakes();
  const x = all[mk.type] || (all[mk.type] = { count: 0, examples: [], rules: [] });
  x.count++;
  x.lastAt = new Date().toISOString();
  x.examples.unshift({ tr: item.tr, wrong: text, right: fixed, pid: item.pid, at: today() });
  x.examples = x.examples.slice(0, 6);
  if (mk.rule && !x.rules.includes(mk.rule)) x.rules = [mk.rule, ...x.rules].slice(0, 4);
  await db.set('mistakes', all);
}
export async function clearMistakeType(type) {
  const all = await loadMistakes();
  delete all[type];
  await db.set('mistakes', all);
}

// ---------- İstatistik ----------
export async function loadStats() { return (await db.get('stats')) || { days: {}, recent: [], bad: [] }; }
export async function recordAnswer(firstTry, tr) {
  const s = await loadStats();
  const d = s.days[today()] || (s.days[today()] = { n: 0, first: 0 });
  d.n++;
  if (firstTry) d.first++;
  s.recent = [...(s.recent || []), tr].slice(-60);
  const keys = Object.keys(s.days).sort();
  while (keys.length > 120) delete s.days[keys.shift()];
  await db.set('stats', s);
}
export async function markBad(tr) {
  const s = await loadStats();
  s.bad = [...(s.bad || []), tr].slice(-100);
  await db.set('stats', s);
}
export function streak(stats) {
  let n = 0;
  for (let i = 0; ; i--) {
    const d = stats.days[today(i)];
    if (d && d.n) n++;
    else if (i === 0) continue; // bugün henüz çalışılmadıysa seri dünden sayılır
    else break;
    if (n > 3650) break;
  }
  return n;
}

// Seviye: çalışılan kalıbın seviyesi ile profil seviyesinin büyüğü
export const levelFor = (profile, pid) => {
  const p = patternById(pid);
  return LEVELS[Math.max(levelIndex(profile.level), p ? levelIndex(p.level) : 0)];
};

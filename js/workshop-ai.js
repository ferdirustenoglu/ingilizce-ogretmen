// Cümle Atölyesi: yapay zekâ ile cümle üretme ve cevap kontrolü

import { chatJSON } from './openai.js';
import { addCost, today, db } from './db.js';
import { RULESET } from './workshop-rules.js';
import { TOOLS, roleKey, patternById } from './workshop-data.js';
import { loadMistakes, saveMistakes, RULES, mistakeTypeLabel } from './analysis.js';

// ---------- Cümle üretme ----------
function genUser({ level, n, patterns, topic, words, focus, avoid }) {
  const lines = ['TASK: GENERATE', `Student level: ${level}`, `Number of items: ${n}`];
  if (patterns.length) {
    lines.push('Patterns to practise (spread them across the exercises):');
    patterns.forEach((p) => lines.push(`- ${p.id}: Turkish "${p.tr}" → English "${p.en}" (${p.title}; formula: ${p.formula})`));
  } else {
    lines.push('No fixed pattern: mix useful structures for this level.');
  }
  if (topic) lines.push(`Topic of the sentences: ${topic.title}${topic.en ? ' / ' + topic.en : ''}.`);
  if (words.length) lines.push(`Daily target words: ${words.join(', ')}. Use them where natural (one or two per sentence, not forced).`);
  if (focus.length) {
    lines.push('Known mistakes of the student (practise them in 1–2 sentences, set "focus" to the id):');
    focus.forEach((m) => lines.push(`- ${m.id}: ${m.key} (wrong: "${m.original}" → right: "${m.corrected}")`));
  }
  if (avoid.length) lines.push(`Do not repeat these recent sentences: ${avoid.join(' | ')}`);
    return lines.join('\n');
}

const str = (v) => (v == null ? '' : String(v)).trim();

// "text/ROLE" biçimindeki tek parçayı çöz. Sonda ! = yanlış, * = değişti
function splitTok(tok) {
  const i = tok.lastIndexOf('/');
  if (i <= 0) return { t: tok.trim(), r: 'X', ok: true, hl: false };
  let r = tok.slice(i + 1).trim().toUpperCase();
  const bad = r.includes('!');
  const hl = r.includes('*');
  r = r.replace(/[!*]/g, '');
  return { t: tok.slice(0, i).trim(), r: roleKey(r), ok: !bad, hl };
}

// Türkçe parçalar: "git/IM -meli/F -yim/O" (veya nesne listesi)
function parsePieces(v) {
  let list = [];
  if (typeof v === 'string') list = v.trim().split(/\s+/).filter(Boolean).map(splitTok);
  else if (Array.isArray(v)) {
    list = v.map((x) => (typeof x === 'string' ? splitTok(x) : x && x.t ? { t: str(x.t), r: roleKey(str(x.r).toUpperCase()), ok: true, hl: false } : null)).filter(Boolean);
  }
  return list.filter((x) => x.t).map((x) => {
    const suffix = x.t.startsWith('-') && x.t.length > 1;
    return { t: x.t, r: x.r, s: suffix ? 1 : 0 };
  });
}

// Parçalar cümleyi gerçekten oluşturuyor mu? (çift görünmeyi ve bozuk ayırmayı engeller)
const letters = (s) => s.toLocaleLowerCase('tr').replace(/[^a-zçğıöşüâîû0-9]/g, '');
function piecesValid(pieces, tr) {
  if (pieces.length < 2) return false;
  const rebuilt = pieces.map((p) => (p.s ? p.t.slice(1) : p.t)).join('');
  return letters(rebuilt) === letters(tr);
}

// İngilizce öğeler: "They/O | will/F | use/IM"
function normParts(v, fallback) {
  let list = [];
  if (typeof v === 'string') list = v.split('|').map((x) => x.trim()).filter(Boolean).map(splitTok);
  else if (Array.isArray(v)) {
    list = v.map((x) => (typeof x === 'string' ? splitTok(x) : x && str(x.t)
      ? { t: str(x.t), r: roleKey(str(x.r).toUpperCase()), ok: x.ok !== false, hl: !!x.hl } : null)).filter(Boolean);
  }
  list = list.filter((x) => x.t);
  return list.length ? list : [{ t: fallback, r: 'X', ok: true, hl: false }];
}

function normItem(x, allowedPatterns) {
  if (!x || !str(x.tr) || !str(x.answer)) return null;
  const pat = str(x.pattern);
  const pieces = parsePieces(x.pieces);
  return {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tr: str(x.tr),
    pieces: piecesValid(pieces, str(x.tr)) ? pieces : [],
    t2: str(x.t2),
    answer: str(x.answer),
    parts: normParts(x.parts, str(x.answer)),
    steps: (Array.isArray(x.steps) ? x.steps : []).filter((st) => st && (st.en || st.tr)).slice(0, 10)
      .map((st) => ({ r: roleKey(str(st.r).toUpperCase()), tr: str(st.tr), en: str(st.en), note: str(st.note) })),
    daily: str(x.daily) || str(x.answer),
    dailyNote: str(x.daily_note_tr),
    rule: str(x.rule_tr),
    tools: (Array.isArray(x.tools) ? x.tools : []).map(str).filter((t) => TOOLS[t]).slice(0, 3),
    words: (Array.isArray(x.words) ? x.words : []).filter((w) => w && w.tr && w.en).slice(0, 4).map((w) => ({ tr: str(w.tr), en: str(w.en) })),
    pattern: allowedPatterns.includes(pat) ? pat : (patternById(pat) ? pat : ''),
    focus: str(x.focus),
    // oturum durumu
    status: null, // 'first' | 'hint' | 'shown' | 'wrong'
    attempts: 0,
    hints: 0,
    draft: '',
    check: null,
  };
}

/**
 * Yeni alıştırma cümleleri üretir.
 * opts: { level, n, patternIds, topic, words, focus (hata kayıtları), avoid (son cümleler) }
 */
export async function generateItems(settings, opts) {
  const patterns = (opts.patternIds || []).map(patternById).filter(Boolean);
  const { data, cost } = await chatJSON(settings, [
    { role: 'system', content: RULESET },
    { role: 'user', content: genUser({ level: opts.level, n: opts.n, patterns, topic: opts.topic, words: opts.words || [], focus: opts.focus || [], avoid: opts.avoid || [] }) },
  ], 1200 + opts.n * 900);
  await addCost(cost);
  const ids = patterns.map((p) => p.id);
  const items = (data.items || []).map((x) => normItem(x, ids)).filter(Boolean);
  if (!items.length) throw new Error('Cümleler hazırlanamadı. Tekrar dene.');
  const focusIds = new Set((opts.focus || []).map((m) => m.id));
  items.forEach((it) => { if (!focusIds.has(it.focus)) it.focus = ''; });
  return { items, cost };
}

// ---------- Cevap kontrolü ----------
export async function checkAnswer(settings, level, item, text, targets = []) {
  const pat = item.pattern ? patternById(item.pattern) : null;
  const user = [
    'TASK: CHECK',
    `Student level: ${level}`,
    `Turkish: "${item.tr}"`,
    `Reference answer: "${item.answer}"`,
    `Reference parts: ${item.parts.map((p) => p.t + '/' + p.r).join(' | ')}`,
    pat ? `Practised pattern: ${pat.tr} → ${pat.en}` : '',
    targets.length ? `Target words: ${targets.join(', ')}` : '',
    `Student wrote: "${text}"`,
  ].filter(Boolean).join('\n');
  const { data, cost } = await chatJSON(settings, [
    { role: 'system', content: RULESET },
    { role: 'user', content: user },
  ], 1600);
  await addCost(cost);
  const verdict = ['correct', 'close', 'wrong'].includes(data.verdict) ? data.verdict : 'wrong';
  const fixed = str(data.fixed) || item.answer;
  return {
    verdict,
    summary: str(data.summary_tr),
    praise: str(data.praise_tr),
    userParts: normParts(data.user_parts, text),
    fixed,
    fixedParts: normParts(data.fixed_parts, fixed),
    explain: (Array.isArray(data.explain) ? data.explain : []).filter((e) => e && (e.title || e.text)).slice(0, 3)
      .map((e) => ({ tag: str(e.tag), title: str(e.title), text: str(e.text), example: str(e.example) })),
    also: data.also && str(data.also.en) && norm(data.also.en) !== norm(fixed) ? { en: str(data.also.en), note: str(data.also.note_tr) } : null,
    mistake: data.mistake && data.mistake.key ? data.mistake : null,
    wordsOk: (data.words_ok || []).map(String),
    wordsBad: (data.words_wrong || []).map(String),
    cost,
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();

// ---------- Hata bankası ----------
// Atölyedeki hata, konuşmadaki hatalarla aynı bankaya düşer. Döner: { added, learned }
export async function recordResult(check, focusId) {
  const all = await loadMistakes();
  const now = new Date().toISOString();
  let added = null;
  let learned = null;
  const mk = check.verdict !== 'correct' ? check.mistake : null;
  if (mk) {
    const key = String(mk.key).toLowerCase().trim();
    let it = all.find((m) => m.key === key);
    if (it) {
      it.count++;
      it.lastAt = now;
      it.original = String(mk.original || it.original);
      it.corrected = String(mk.corrected || it.corrected);
      if (it.status === 'learned') { it.status = 'active'; it.correctLessons = []; }
    } else {
      it = {
        id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        type: mistakeTypeLabel(mk.type) !== mistakeTypeLabel('other') ? mk.type : 'other',
        key,
        original: String(mk.original || ''),
        corrected: String(mk.corrected || ''),
        rule_tr: String(mk.rule_tr || ''),
        count: 1,
        correctLessons: [],
        status: 'active',
        source: 'atolye',
        firstAt: now,
        lastAt: now,
      };
      all.push(it);
    }
    added = it;
  }
  if (focusId) {
    const it = all.find((m) => m.id === focusId);
    if (it && it.status === 'active') {
      it.lastPracticed = now;
      if (check.verdict === 'correct') {
        const tag = 'ws-' + today();
        if (!it.correctLessons.includes(tag)) it.correctLessons.push(tag);
        if (it.correctLessons.length >= RULES.learnedAfter) { it.status = 'learned'; it.learnedAt = now; learned = it; }
      }
    }
  }
  if (mk || focusId) await saveMistakes(all);
  return { added, learned };
}

// ---------- Yerel kayıtlar ----------
export const loadSession = async () => (await db.get('wsSession')) || null;
export const saveSession = (s) => db.set('wsSession', s);
export const clearSession = () => db.del('wsSession');
export const loadWsStats = async () => (await db.get('wsStats')) || { patterns: {}, days: {}, recent: [] };
export const saveWsStats = (s) => db.set('wsStats', s);
export const loadWsHistory = async () => (await db.get('wsHistory')) || [];
export const saveWsHistory = (h) => db.set('wsHistory', h.slice(0, 30));

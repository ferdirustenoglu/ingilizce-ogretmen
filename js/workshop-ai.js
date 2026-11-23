// Cümle Atölyesi: yapay zekâ ile cümle üretme ve cevap kontrolü

import { chatJSON } from './openai.js';
import { addCost, today, db } from './db.js';
import { LEVELS } from './topics.js';
import { TOOLS, roleKey, patternById } from './workshop-data.js';
import { loadMistakes, saveMistakes, RULES, mistakeTypeLabel } from './analysis.js';

const ROLE_RULES = `ROLE CODES for sentence parts:
O = subject (Özne).
F = "ortaç": the auxiliary / modal / tense helper: can, could, must, should, will, would, 'd better, have to, used to, do/does/did, am/is/are/was/were (as auxiliary or linking verb), have/has/had (perfect). Negation belongs to F: don't, can't, isn't, didn't.
IM = "imaj": the main verb (go, called, cooking). In a sentence whose only verb is am/is/are, the adjective or noun after it is IM (I | 'm | tired).
N = objects and complements, prepositional phrases WITH their preposition and article (a car, my keys, to the office, from Istanbul).
Z = adverbs and time / place / manner expressions (early, tomorrow, every morning, quietly, here, right now).
B = conjunctions and relative words (because, when, if, although, who, that, so).
X = anything else (there in "there is", please, it as dummy subject can be O).`;

const toolList = () => Object.entries(TOOLS).map(([k, t]) => `${k} (${t.title})`).join(', ');

// ---------- Cümle üretme ----------
function genSystem(level) {
  return `You create Turkish → English translation exercises for an adult Turkish learner. Student level: ${level} (scale ${LEVELS.join(', ')}).
The app colour-codes sentence parts. ${ROLE_RULES}

For each exercise return an object with:
- "tr": one natural everyday Turkish sentence (how people really talk), suited to the level: 4–10 words for A1–A2, up to 16 words for B1 and above. Adult life: work, family, home, shopping, travel, health, friends, plans.
- "pieces": the Turkish sentence split into parts with roles, in Turkish word order. Split each verb into its root (IM), tense/modal/negation/question suffixes (F) and personal ending (O): git + -meli + -yim → IM, F, O. Suffix pieces start with "-" and have "s":1. A case suffix keeps its noun's role: ofis (N) + -e (N, s:1). A separate subject word (Ben, Annem) is O. No punctuation pieces. Joining the pieces must rebuild the sentence's words.
- "t2": the "opened Turkish" sentence: add in parentheses what Turkish leaves unsaid but English needs: the subject pronoun, "(o bilinen)" before a definite known thing, "(bir)" for a/an, hidden meanings like "(durumdayım)". Show suffixes with hyphens. Example: "(Ben) yarın (o bilinen) ofis-e erken git-meli-yim."
- "answer": the correct, natural English translation (use the target pattern when one is given). NEVER teaching-only forms like "I did come" or "I do talk".
- "parts": "answer" split into role parts in English order, each {"t","r"}. Contractions are split: I + 'm (F), you + 'd better (F).
- "daily": how a native speaker would most naturally say it in casual everyday conversation. Same as "answer" if that is already the most natural.
- "daily_note_tr": if "daily" differs from "answer": 1–2 short Turkish sentences explaining why it sounds more natural; otherwise "".
- "rule_tr": one short Turkish sentence with the key point of this sentence.
- "tools": ids of the tools that help with this sentence, chosen from: ${toolList()}.
- "words": up to 4 key words {"tr","en"} (Turkish as in the sentence → English).
- "pattern": the id of the practised pattern from the given list, or "".
- "focus": the id of the known mistake this sentence practises, or "".
Turkish must be correct and natural. English must be correct and natural.
Return ONLY JSON: {"items":[ ... ]}`;
}

function genUser({ n, patterns, topic, words, focus, avoid }) {
  const lines = [`Make ${n} exercises.`];
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
  lines.push('Vary subjects (I, you, he, we, they, my boss, the children…) and forms (positive, negative, question).');
  return lines.join('\n');
}

const str = (v) => (v == null ? '' : String(v)).trim();

function normParts(list, fallback) {
  const out = (Array.isArray(list) ? list : [])
    .filter((x) => x && str(x.t))
    .map((x) => ({ t: str(x.t), r: roleKey(str(x.r).toUpperCase()), s: x.s ? 1 : 0, ok: x.ok, hl: !!x.hl }));
  return out.length ? out : [{ t: fallback, r: 'X', s: 0 }];
}

function normItem(x, allowedPatterns) {
  if (!x || !str(x.tr) || !str(x.answer)) return null;
  const pat = str(x.pattern);
  return {
    id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tr: str(x.tr),
    pieces: normParts(x.pieces, str(x.tr)),
    t2: str(x.t2),
    answer: str(x.answer),
    parts: normParts(x.parts, str(x.answer)),
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
    { role: 'system', content: genSystem(opts.level) },
    { role: 'user', content: genUser({ n: opts.n, patterns, topic: opts.topic, words: opts.words || [], focus: opts.focus || [], avoid: opts.avoid || [] }) },
  ], 900 + opts.n * 650);
  await addCost(cost);
  const ids = patterns.map((p) => p.id);
  const items = (data.items || []).map((x) => normItem(x, ids)).filter(Boolean);
  if (!items.length) throw new Error('Cümleler hazırlanamadı. Tekrar dene.');
  const focusIds = new Set((opts.focus || []).map((m) => m.id));
  items.forEach((it) => { if (!focusIds.has(it.focus)) it.focus = ''; });
  return { items, cost };
}

// ---------- Cevap kontrolü ----------
function checkSystem(level) {
  return `You check an adult Turkish learner's English translation. Student level: ${level}.
Be fair: accept ANY correct, natural translation, even if it differs from the reference (another fitting tense, synonyms, with or without contractions). Ignore capitalisation and final punctuation. A one-letter typo makes it "close" (mention it).
${ROLE_RULES}
Return ONLY JSON:
{"verdict": "correct" | "close" | "wrong",
 "summary_tr": "one short Turkish line, e.g. 'İskelet doğru, 1 parçada eksik var.' or 'Harika, tamamen doğru!'",
 "user_parts": [the student's answer split into role parts in THEIR order: {"t","r","ok": true|false}],
 "fixed": "the corrected sentence closest to the student's own words (equal to the student's answer if correct)",
 "fixed_parts": [fixed split into role parts: {"t","r","hl": true if this part was changed or added}],
 "explain": [for each real error, max 3: {"tag": "the English word(s) involved, very short, e.g. 'to', 'the', 'went'", "title": "short Turkish rule name", "text": "1–2 short, simple Turkish sentences"}],
 "also": {"en": "another correct translation different from fixed, worth knowing", "note_tr": "one Turkish sentence on the difference"} or null,
 "mistake": {"type": "tense|verb_form|article|preposition|word_choice|word_order|agreement|pronoun|plural|question_form|other", "key": "short stable English rule label", "original": "wrong part", "corrected": "right part", "rule_tr": "max 12 Turkish words"} or null,
 "words_ok": [target words used correctly], "words_wrong": [target words used wrongly]}
verdict: "close" = meaning and structure are right but 1–2 small errors (article, preposition, -s, one word form). "wrong" = structure or meaning is wrong, or it is not English.
For "explain" titles prefer these names when they fit: Hayat Üçgeni (a/an/the/plural -s), Edat varsa çek başa (prepositions from Turkish case endings), Sırayı çevir (word order), -di’nin iki anlamı (past simple vs present perfect), Parantez mantığı (relative clauses), Önce ana cümle (clause order with conjunctions). "explain" is [] when the answer is correct.`;
}

export async function checkAnswer(settings, level, item, text, targets = []) {
  const pat = item.pattern ? patternById(item.pattern) : null;
  const user = [
    `Turkish: "${item.tr}"`,
    `Reference answer: "${item.answer}"`,
    pat ? `Practised pattern: ${pat.tr} → ${pat.en}` : '',
    targets.length ? `Target words: ${targets.join(', ')}` : '',
    `Student wrote: "${text}"`,
  ].filter(Boolean).join('\n');
  const { data, cost } = await chatJSON(settings, [
    { role: 'system', content: checkSystem(level) },
    { role: 'user', content: user },
  ], 1400);
  await addCost(cost);
  const verdict = ['correct', 'close', 'wrong'].includes(data.verdict) ? data.verdict : 'wrong';
  const fixed = str(data.fixed) || item.answer;
  return {
    verdict,
    summary: str(data.summary_tr),
    userParts: normParts(data.user_parts, text).map((x) => ({ ...x, ok: x.ok !== false })),
    fixed,
    fixedParts: normParts(data.fixed_parts, fixed),
    explain: (Array.isArray(data.explain) ? data.explain : []).filter((e) => e && (e.title || e.text)).slice(0, 3)
      .map((e) => ({ tag: str(e.tag), title: str(e.title), text: str(e.text) })),
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

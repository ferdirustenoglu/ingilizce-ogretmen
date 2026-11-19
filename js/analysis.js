// Aşama 3: Arka plan analiz
// Her öğrenci cümlesinden sonra ucuz metin modeli cümleyi puanlar, hataları bulur.
// Bu sonuçlarla seviye, hata bankası ve kelime arşivi güncellenir.

import { db, saveProfile, addCost, today } from './db.js';
import { LEVELS, topicById } from './topics.js';
import { textCost } from './openai.js';

const BASE = 'https://api.openai.com/v1';

// ---------- Ayarlanabilir kurallar ----------
export const RULES = {
  windowSize: 20, // normal değerlendirme: her 20 cümlede bir
  upAt: 85, // ortalama ≥ 85 → bir basamak yukarı
  downAt: 55, // ortalama ≤ 55 → bir basamak aşağı
  placementWindow: 5, // yerleştirme: her 5 cümlede bir
  placementTotal: 40, // ilk 40 cümle yerleştirme dönemi
  learnedAfter: 3, // bir hata 3 farklı derste doğru kullanılınca öğrenildi
  reviewDays: [1, 3, 7, 14], // kelime tekrar aralıkları
};

const MISTAKE_TYPES = {
  tense: 'Zaman kipi', verb_form: 'Fiil hali', article: 'Article', preposition: 'Edat',
  word_choice: 'Kelime seçimi', word_order: 'Kelime sırası', agreement: 'Özne-fiil uyumu',
  pronoun: 'Zamir', plural: 'Çoğul', question_form: 'Soru yapısı', other: 'Diğer',
};
export const mistakeTypeLabel = (t) => MISTAKE_TYPES[t] || MISTAKE_TYPES.other;

// ---------- Veriler ----------
export const loadMistakes = async () => (await db.get('mistakes')) || [];
export const saveMistakes = (m) => db.set('mistakes', m);
export const loadWordArchive = async () => (await db.get('wordArchive')) || {};
export const saveWordArchive = (w) => db.set('wordArchive', w);

// Yerel saate göre (Türkiye) gün hesabı
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// ---------- Ders başında: odak hatalar ve tekrar kelimeleri ----------
// Aktif hatalardan en çok yapılan ve uzun süredir çalışılmayan 2 tanesini seç
export async function pickFocusMistakes(n = 2) {
  const list = (await loadMistakes()).filter((m) => m.status === 'active');
  list.sort((a, b) => (b.count - a.count) || String(a.lastPracticed || '').localeCompare(String(b.lastPracticed || '')));
  return list.slice(0, n).map((m) => m.id);
}

// Tekrar zamanı gelen eski kelimeler (bugünkü listede olmayanlar)
export async function pickReviewWords(currentWords, n = 5) {
  const arc = await loadWordArchive();
  const cur = new Set(currentWords.map((w) => w.toLowerCase()));
  const t = today();
  return Object.entries(arc)
    .filter(([w, v]) => !cur.has(w) && v.nextReview && v.nextReview <= t)
    .sort((a, b) => a[1].nextReview.localeCompare(b[1].nextReview))
    .slice(0, n)
    .map(([w]) => w);
}

// Bugünün kelimelerini arşive kaydet
export async function registerWords(words) {
  const arc = await loadWordArchive();
  let changed = false;
  words.forEach((w) => {
    const k = w.toLowerCase();
    if (!arc[k]) {
      arc[k] = { firstAt: today(), okCount: 0, badCount: 0, stage: 0, nextReview: null };
      changed = true;
    }
  });
  if (changed) await saveWordArchive(arc);
}

// Kelime kullanıldığında arşivi güncelle (öğretmenin işaretlerinden)
export async function recordWordUse(okWords, badWords) {
  if (!okWords.length && !badWords.length) return;
  const arc = await loadWordArchive();
  const t = today();
  okWords.forEach((w) => {
    const k = w.toLowerCase();
    const v = arc[k] || (arc[k] = { firstAt: t, okCount: 0, badCount: 0, stage: 0, nextReview: null });
    v.okCount++;
    // Aynı gün içinde birden fazla doğru kullanım aşamayı bir kez ilerletir
    if (v.lastOk !== t) {
      v.stage = Math.min(v.stage + 1, RULES.reviewDays.length);
      v.nextReview = v.stage >= RULES.reviewDays.length ? null : addDays(RULES.reviewDays[v.stage - 1]);
      v.lastOk = t;
    }
  });
  badWords.forEach((w) => {
    const k = w.toLowerCase();
    const v = arc[k] || (arc[k] = { firstAt: t, okCount: 0, badCount: 0, stage: 0, nextReview: null });
    v.badCount++;
    v.stage = 0;
    v.nextReview = addDays(1);
  });
  await saveWordArchive(arc);
}

// ---------- Cümle analizi ----------
function analysisPrompt(profile, study, bank, targets = []) {
  const topics = study.topics.map(topicById).filter(Boolean).map((t) => t.title);
  return `You are an expert English examiner analysing ONE spoken sentence from an adult Turkish learner (speech-to-text transcript: ignore punctuation, capitalization and obvious transcription glitches).
Student's current level: ${profile.level} (scale: ${LEVELS.join(', ')}).
${topics.length ? 'Lesson topics: ' + topics.join('; ') + '.' : ''}
Score the sentence 0-100 RELATIVE TO THE CURRENT LEVEL on:
- accuracy (grammar correctness), vocabulary (range and precision), complexity (sentence structure), naturalness (sounds like natural English).
Calibration: ~70 = typical for this level; 85+ = clearly above this level; below 55 = struggling at this level. Very short or yes/no answers get low complexity. Never inflate.
Also give "estimated_level": the level on the 12-step scale that this sentence most likely shows.
List real mistakes only (max 3). For each: "type" (one of: ${Object.keys(MISTAKE_TYPES).join(', ')}), "key" (short stable English label of the rule, e.g. "past simple of irregular verbs", "article before singular job nouns"), "original" (the wrong part), "corrected" (the corrected part), "rule_tr" (very short Turkish rule, max 12 words).
${bank.length ? `Known mistakes from earlier lessons (id: rule):
${bank.map((m) => `${m.id}: ${m.key}`).join('\n')}
"bank_correct": ids the student used CORRECTLY in this sentence (the structure actually appears and is right). "bank_repeated": ids the student got wrong again.` : 'There are no known earlier mistakes: return empty "bank_correct" and "bank_repeated".'}
${targets.length ? `Target words: ${targets.join(', ')}. "words_used_ok": target words the student used correctly in this sentence (any correct form counts, e.g. "went" for "go" when past is needed). "words_used_wrong": target words used wrongly.` : 'No target words: return empty "words_used_ok" and "words_used_wrong".'}
Return ONLY JSON: {"scores":{"accuracy":0,"vocabulary":0,"complexity":0,"naturalness":0},"estimated_level":"A1","mistakes":[],"bank_correct":[],"bank_repeated":[],"words_used_ok":[],"words_used_wrong":[]}`;
}

async function callAnalysis(settings, system, user) {
  const model = settings.models.analysis;
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_completion_tokens: 600,
  };
  if (model.startsWith('gpt-5')) body.reasoning_effort = 'minimal';
  const send = () => fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res = await send();
  if (!res.ok && res.status === 400 && body.reasoning_effort) {
    delete body.reasoning_effort;
    res = await send();
  }
  if (!res.ok) throw new Error('Analiz hatası ' + res.status);
  const j = await res.json();
  return { data: JSON.parse(j.choices?.[0]?.message?.content || '{}'), cost: textCost(model, j.usage) };
}

// Analizler sırayla işlenir (profil güncellemeleri karışmasın)
let queue = Promise.resolve();

export function analyzeSentence(state, args, onResult) {
  queue = queue.then(() => runAnalysis(state, args).then(onResult)).catch((e) => {
    console.warn('analysis failed', e);
  });
  return queue;
}

async function runAnalysis(state, { text, prevTeacher, lessonId, targets = [] }) {
  const { settings, profile, study } = state;
  const all = await loadMistakes();
  const bank = all.filter((m) => m.status === 'active').slice(0, 15);
  const user = (prevTeacher ? `Teacher asked: "${prevTeacher}"\n` : '') + `Student said: "${text}"`;
  const { data, cost } = await callAnalysis(settings, analysisPrompt(profile, study, bank, targets), user);
  await addCost(cost);

  const sc = data.scores || {};
  const vals = ['accuracy', 'vocabulary', 'complexity', 'naturalness'].map((k) => clamp(+sc[k]));
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / 4);
  const scores = { accuracy: vals[0], vocabulary: vals[1], complexity: vals[2], naturalness: vals[3], avg };

  // Hata bankasını güncelle
  const now = new Date().toISOString();
  const added = [];
  const learned = [];
  (data.mistakes || []).slice(0, 3).forEach((mk) => {
    if (!mk || !mk.key) return;
    const key = String(mk.key).toLowerCase().trim();
    let item = all.find((m) => m.key === key);
    if (item) {
      item.count++;
      item.lastAt = now;
      item.original = mk.original || item.original;
      item.corrected = mk.corrected || item.corrected;
      if (item.status === 'learned') { item.status = 'active'; item.correctLessons = []; }
    } else {
      item = {
        id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        type: MISTAKE_TYPES[mk.type] ? mk.type : 'other',
        key,
        original: String(mk.original || ''),
        corrected: String(mk.corrected || ''),
        rule_tr: String(mk.rule_tr || ''),
        count: 1,
        correctLessons: [],
        status: 'active',
        firstAt: now,
        lastAt: now,
      };
      all.push(item);
      added.push(item);
    }
  });
  const ids = new Set(bank.map((m) => m.id));
  (data.bank_correct || []).forEach((id) => {
    const item = all.find((m) => m.id === id);
    if (!item || !ids.has(id)) return;
    item.lastPracticed = now;
    if (!item.correctLessons.includes(lessonId)) item.correctLessons.push(lessonId);
    if (item.correctLessons.length >= RULES.learnedAfter) {
      item.status = 'learned';
      item.learnedAt = now;
      learned.push(item);
    }
  });
  (data.bank_repeated || []).forEach((id) => {
    const item = all.find((m) => m.id === id);
    if (!item || !ids.has(id)) return;
    item.count++;
    item.lastAt = now;
    item.lastPracticed = now;
  });
  await saveMistakes(all);

  // Seviye hesabı
  const levelChange = settings.autoLevel ? updateLevel(profile, scores.avg, data.estimated_level) : null;
  await saveProfile(profile);

  const firstMistake = (data.mistakes || []).find((m) => m && m.corrected);
  return {
    scores, estimated: data.estimated_level, added, learned, levelChange,
    mistake: firstMistake || null,
    wordsOk: (data.words_used_ok || []).map(String),
    wordsBad: (data.words_used_wrong || []).map(String),
  };
}

const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 60);

// Seviyeyi günceller; değiştiyse { from, to } döner
export function updateLevel(profile, avg, estimated) {
  profile.window = profile.window || [];
  profile.estimates = profile.estimates || [];
  profile.analyzedCount = (profile.analyzedCount || 0) + 1;
  profile.window.push(avg);
  if (LEVELS.includes(estimated)) profile.estimates.push(estimated);

  const from = profile.level;
  let to = from;

  if (!profile.placementDone) {
    // Yerleştirme: her 5 cümlede tahmin edilen seviyelerin ortancasına geç (birden fazla basamak atlayabilir)
    if (profile.window.length >= RULES.placementWindow) {
      const idx = profile.estimates.slice(-RULES.placementWindow).map((l) => LEVELS.indexOf(l)).sort((a, b) => a - b);
      if (idx.length) to = LEVELS[idx[Math.floor(idx.length / 2)]];
      profile.window = [];
    }
    if (profile.analyzedCount >= RULES.placementTotal) {
      profile.placementDone = true;
      profile.window = [];
      profile.estimates = [];
    }
  } else if (profile.window.length >= RULES.windowSize) {
    const mean = profile.window.reduce((a, b) => a + b, 0) / profile.window.length;
    const i = LEVELS.indexOf(from);
    if (mean >= RULES.upAt) to = LEVELS[Math.min(i + 1, LEVELS.length - 1)];
    else if (mean <= RULES.downAt) to = LEVELS[Math.max(i - 1, 0)];
    profile.lastWindowAvg = Math.round(mean);
    profile.window = [];
    profile.estimates = [];
  }

  if (to !== from) {
    profile.level = to;
    profile.levelHistory = profile.levelHistory || [];
    profile.levelHistory.push({ level: to, at: new Date().toISOString() });
    profile.levelNotice = { from, to };
    return { from, to };
  }
  return null;
}

// Ana sayfadaki ilerleme çubuğu için
export function levelProgress(profile) {
  const n = (profile.window || []).length;
  if (!profile.placementDone) {
    const done = profile.analyzedCount || 0;
    return { pct: Math.min(100, Math.round((done / RULES.placementTotal) * 100)), text: `Seviye ölçülüyor: ${done} / ${RULES.placementTotal} cümle` };
  }
  const avg = n ? Math.round(profile.window.reduce((a, b) => a + b, 0) / n) : null;
  return {
    pct: Math.round((n / RULES.windowSize) * 100),
    text: `Değerlendirme: ${n} / ${RULES.windowSize} cümle` + (avg !== null ? ` · ortalama ${avg}` : ''),
  };
}

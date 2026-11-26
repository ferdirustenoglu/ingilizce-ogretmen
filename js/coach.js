// Koç: cevap günlüğü, 25 cümlede bir analiz, kişisel ders, ölçme.
//
// ALGORİTMA
// 1) Her ilk deneme cevabı günlüğe yazılır (cümle, cevap, doğrusu, hata türleri).
// 2) Her 25 cevapta bir analiz yapılır (ANALYSIS_WINDOW).
//    - Pencere = son analizden bu yana verilen cevaplar.
//    - Her hata türü için hata sayısı çıkarılır (yazım hataları yarım puan sayılır).
//    - İzlemedeki dersler değerlendirilir: o türden en fazla 1 hata → "öğrenildi",
//      daha fazlası → ders "tekrar anlatım" ile yeniden açılır.
//    - Açık dersi olmayan en yüksek puanlı tür LESSON_TRIGGER (3) puanı geçerse yeni ders hazırlanır.
// 3) Ders: yapay zekâ, kullanıcının o türdeki kendi yanlış cümleleriyle kişisel bir özet ders yazar.
// 4) "Çalıştım" → o konuya özel 6 cümle. O türden en fazla 1 hata → "izlemede";
//    daha fazlası → ders farklı bir anlatımla yeniden hazırlanır.
// 5) İzlemedeki ders, sonraki 25 cümlelik analizde o türden en fazla 1 hata varsa "öğrenildi" olur.

import { db } from './db.js';
import { askJSON } from './ai.js';
import { RULES, mistakeLabel } from './rules.js';
import { patternById } from './curriculum.js';

export const ANALYSIS_WINDOW = 25;
export const LESSON_TRIGGER = 3;
export const PRACTICE_SIZE = 6;
const WEIGHT = { spelling: 0.5 };

// Hata türü için varsayılan alıştırma kalıpları
const TYPE_PATTERNS = {
  article: ['u1-article', 'u1-there'], preposition: ['u1-prep', 'u2-past'], tense: ['u2-past', 'u4-perfect', 'u1-simple'],
  aux: ['u5-must', 'u5-should', 'u1-can'], verb_form: ['u2-did', 'u1-do', 'u4-perfect'], agreement: ['u1-simple', 'u1-be'],
  plural: ['u1-article', 'u6-many'], word_order: ['u1-do', 'u1-there', 'u8-because'], word_choice: ['u7-wantto', 'u1-simple'],
  missing: ['u1-be', 'u2-cont'], conjunction: ['u8-because', 'u8-when'], relative: ['u9-relative'], spelling: ['u1-simple', 'u2-past'],
  naturalness: ['gk-feel', 'u5-wouldlike'],
};

const STATUS_LABEL = { ready: 'Hazır', watching: 'İzlemede', learned: 'Öğrenildi' };
export const lessonStatusLabel = (st) => STATUS_LABEL[st] || st;

export async function loadCoach() {
  return { answered: 0, lastAnalysisAt: 0, lessons: [], reports: [], ...((await db.get('coach')) || {}) };
}
const saveCoach = (c) => db.set('coach', c);
export async function loadLog() { return (await db.get('answerLog')) || []; }

// ---------- 1) Cevap kaydı ----------
// Döner: yeni analiz yapıldıysa { report, newLesson, learned[], retaught[] }
export async function logAnswer({ item, text, check, verdict }) {
  const coach = await loadCoach();
  const log = await loadLog();
  coach.answered++;
  const types = [...new Set([
    ...((check && check.explain) || []).map((e) => e.type).filter(Boolean),
    ...(check && check.mistake ? [check.mistake.type] : []),
  ])];
  log.push({
    n: coach.answered, at: new Date().toISOString(), pid: item.pid, tr: item.tr, text,
    right: (check && check.fixed) || item.answer, verdict, types,
    key: check && check.mistake ? check.mistake.key : '',
  });
  await db.set('answerLog', log.slice(-400));
  await saveCoach(coach);
  if (coach.answered - coach.lastAnalysisAt >= ANALYSIS_WINDOW) return analyze();
  return null;
}

// ---------- 2) Analiz ----------
export async function analyze() {
  const coach = await loadCoach();
  const log = await loadLog();
  const win = log.filter((e) => e.n > coach.lastAnalysisAt);
  if (!win.length) return null;
  const counts = {};
  win.forEach((e) => e.types.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const correct = win.filter((e) => e.verdict === 'correct').length;
  const result = { learned: [], retaught: [], newLesson: null };

  // İzlemedeki dersleri değerlendir: sadece alıştırmadan SONRA verilen cevaplara bakılır
  coach.lessons.filter((l) => l.status === 'watching').forEach((l) => {
    const after = log.filter((e) => e.n > (l.watchFrom || 0));
    if (after.length < ANALYSIS_WINDOW) return; // henüz yeterli cevap yok, izlemeye devam
    const errs = after.slice(0, ANALYSIS_WINDOW).filter((e) => e.types.includes(l.type)).length;
    if (errs <= 1) {
      l.status = 'learned';
      l.learnedAt = new Date().toISOString();
      result.learned.push(l);
    } else {
      reteach(l, counts[l.type]);
      result.retaught.push(l);
    }
  });

  // Yeni ders gerekiyor mu?
  const open = new Set(coach.lessons.filter((l) => l.status !== 'learned').map((l) => l.type));
  const ranked = Object.entries(counts)
    .map(([t, c]) => [t, c * (WEIGHT[t] || 1)])
    .filter(([t]) => !open.has(t))
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] >= LESSON_TRIGGER) {
    const [type] = ranked[0];
    result.newLesson = newLesson(coach, type, `Son ${win.length} cümlede ${counts[type]} kez ${mistakeLabel(type).toLowerCase()} hatası yaptın.`);
  }

  const report = { at: new Date().toISOString(), size: win.length, correct, counts, from: coach.lastAnalysisAt + 1, to: coach.answered };
  coach.reports = [report, ...(coach.reports || [])].slice(0, 12);
  coach.lastAnalysisAt = coach.answered;
  await saveCoach(coach);
  return { report, ...result };
}

function newLesson(coach, type, reason) {
  const l = {
    id: 'L' + Date.now().toString(36),
    type, status: 'ready', attempt: 1, reason,
    createdAt: new Date().toISOString(), content: null, history: [],
  };
  coach.lessons.unshift(l);
  return l;
}

function reteach(l, errors) {
  l.history.push({ at: new Date().toISOString(), result: 'retaught', errors });
  l.status = 'ready';
  l.attempt++;
  l.content = null; // bir sonraki açılışta farklı bir anlatımla yeniden yazılır
  l.reason = `Bu konuda hâlâ hata yapıyorsun (${errors} hata). Konuyu farklı bir yoldan tekrar anlatıyorum.`;
}

// Hata defterinden elle ders isteme
export async function requestLesson(type) {
  const coach = await loadCoach();
  const existing = coach.lessons.find((l) => l.type === type && l.status !== 'learned');
  if (existing) return existing;
  const l = newLesson(coach, type, `${mistakeLabel(type)} konusunda ders istedin.`);
  await saveCoach(coach);
  return l;
}

export async function getLesson(id) {
  const coach = await loadCoach();
  return coach.lessons.find((l) => l.id === id) || null;
}

// ---------- 3) Ders içeriği (yapay zekâ, kişisel hatalarla) ----------
export async function lessonExamples(type, n = 8) {
  const log = await loadLog();
  return log.filter((e) => e.types.includes(type)).slice(-n).reverse();
}

export async function ensureLessonContent(settings, lessonId, level) {
  const coach = await loadCoach();
  const l = coach.lessons.find((x) => x.id === lessonId);
  if (!l) throw new Error('Ders bulunamadı.');
  if (l.content) return l;
  const ex = await lessonExamples(l.type);
  const keys = [...new Set(ex.map((e) => e.key).filter(Boolean))].slice(0, 6);
  const user = [
    'TASK: LESSON',
    `Student level: ${level}`,
    `Mistake type: ${l.type} (${mistakeLabel(l.type)})`,
    `Attempt: ${l.attempt}${l.attempt > 1 ? ' (the previous explanation did not work: explain it differently, simpler, with more and clearer examples)' : ''}`,
    keys.length ? `Rule labels seen: ${keys.join('; ')}` : '',
    'The learner\'s own recent sentences with this mistake:',
    ...(ex.length ? ex.map((e) => `- Turkish: "${e.tr}" | learner wrote: "${e.text}" | correct: "${e.right}"`) : ['- (no examples yet: teach the most common problems Turkish speakers have with this topic)']),
  ].filter(Boolean).join('\n');
  const { data } = await askJSON(settings, RULES, user, { maxTokens: 6000, effort: 'medium' });
  const s = (v) => (v == null ? '' : String(v)).trim();
  const content = {
    title: s(data.title) || mistakeLabel(l.type),
    summary: s(data.summary_tr),
    why: s(data.why_tr),
    rules: (Array.isArray(data.rules) ? data.rules : []).filter((r) => r && (r.rule_tr || r.pattern)).slice(0, 5).map((r) => ({
      rule: s(r.rule_tr), pattern: s(r.pattern),
      examples: (Array.isArray(r.examples) ? r.examples : []).filter((e) => e && e.en).slice(0, 3).map((e) => ({ en: s(e.en), tr: s(e.tr) })),
    })),
    table: data.table && Array.isArray(data.table.headers) && Array.isArray(data.table.rows) ? {
      headers: data.table.headers.map(s).slice(0, 4),
      rows: data.table.rows.filter(Array.isArray).slice(0, 10).map((r) => r.map(s).slice(0, 4)),
    } : null,
    mine: (Array.isArray(data.my_mistakes) ? data.my_mistakes : []).filter((m) => m && m.right).slice(0, 5)
      .map((m) => ({ wrong: s(m.wrong), right: s(m.right), note: s(m.note_tr) })),
    tips: (Array.isArray(data.tips) ? data.tips : []).map(s).filter(Boolean).slice(0, 4),
    quiz: (Array.isArray(data.quiz) ? data.quiz : []).filter((q) => q && q.q && Array.isArray(q.options) && q.answer).slice(0, 4)
      .map((q) => ({ q: s(q.q), options: q.options.map(s).slice(0, 4), answer: s(q.answer), explain: s(q.explain_tr) })),
    focus: s(data.practice_focus) || keys.join('; '),
  };
  // Güncel hâlini al (bu arada değişmiş olabilir)
  const fresh = await loadCoach();
  const fl = fresh.lessons.find((x) => x.id === lessonId);
  if (!fl) throw new Error('Ders bulunamadı.');
  fl.content = content;
  await saveCoach(fresh);
  return fl;
}

// ---------- 4) Derse özel alıştırma ----------
export async function lessonSpecs(lessonId) {
  const l = await getLesson(lessonId);
  if (!l) return [];
  const ex = await lessonExamples(l.type);
  let pids = [...new Set(ex.map((e) => e.pid).filter((p) => patternById(p)))];
  if (!pids.length) pids = TYPE_PATTERNS[l.type] || ['u1-simple'];
  const focus = `${mistakeLabel(l.type)}${l.content && l.content.focus ? ' — ' + l.content.focus : ''}. Every sentence must clearly require getting this right.`;
  return Array.from({ length: PRACTICE_SIZE }, (_, i) => ({ pid: pids[i % pids.length], form: 'natural daily-life sentence', focus }));
}

// Döner: { passed, errors }
export async function lessonPracticeDone(lessonId, items) {
  const coach = await loadCoach();
  const l = coach.lessons.find((x) => x.id === lessonId);
  if (!l) return null;
  const errors = items.filter((it) => it.firstVerdict === 'shown' || (it.firstTypes || []).includes(l.type)).length;
  const passed = errors <= 1;
  l.history.push({ at: new Date().toISOString(), result: passed ? 'practice-passed' : 'practice-failed', errors });
  if (passed) {
    l.status = 'watching';
    l.watchFrom = coach.answered;
  } else {
    reteach(l, errors);
  }
  await saveCoach(coach);
  return { passed, errors, attempt: l.attempt };
}

// Ana sayfa / Defter için özet
export async function coachSummary() {
  const coach = await loadCoach();
  const ready = coach.lessons.filter((l) => l.status === 'ready');
  const watching = coach.lessons.filter((l) => l.status === 'watching');
  return {
    coach,
    ready,
    watching,
    untilNext: ANALYSIS_WINDOW - (coach.answered - coach.lastAnalysisAt),
    progress: coach.answered - coach.lastAnalysisAt,
  };
}

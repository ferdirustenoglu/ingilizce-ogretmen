// Telefonda kalıcı veri saklama (IndexedDB üzerinde basit anahtar-değer deposu)

const DB_NAME = 'ingilizce-ogretmen';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  get: (key) => tx('readonly', (s) => s.get(key)),
  set: (key, value) => tx('readwrite', (s) => s.put(value, key)),
  del: (key) => tx('readwrite', (s) => s.delete(key)),
  keys: () => tx('readonly', (s) => s.getAllKeys()),
  clear: () => tx('readwrite', (s) => s.clear()),
};

// Varsayılan değerler
export const DEFAULT_SETTINGS = {
  apiKey: '',
  voiceMode: 'realtime', // 'realtime' | 'ptt' (Bas-Konuş)
  modelSize: 'mini', // 'mini' | 'large'
  models: {
    realtimeMini: 'gpt-realtime-2.1-mini',
    realtimeLarge: 'gpt-realtime-2.1',
    chat: 'gpt-5-mini',
    analysis: 'gpt-5-mini',
    transcribe: 'gpt-4o-mini-transcribe',
    transcribeHigh: 'gpt-4o-transcribe',
    tts: 'gpt-4o-mini-tts',
    audio: 'gpt-audio-1.5',
  },
  transcribeQuality: 'high', // 'high' | 'standard'
  voice: 'marin',
  speed: 'auto', // 'auto' | 'slow' | 'normal' | 'fast'
  correction: 'all', // 'all' | 'important'
  autoLevel: true,
};

export const DEFAULT_PROFILE = {
  level: 'A1',
  sentenceCount: 0,
  placementDone: false,
  levelHistory: [{ level: 'A1', at: null }],
};

export const DEFAULT_STUDY = { topics: [], words: [] };

export async function loadSettings() {
  const s = (await db.get('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...s, models: { ...DEFAULT_SETTINGS.models, ...(s.models || {}) } };
}
export const saveSettings = (s) => db.set('settings', s);

export async function loadProfile() {
  return { ...DEFAULT_PROFILE, ...((await db.get('profile')) || {}) };
}
export const saveProfile = (p) => db.set('profile', p);

export async function loadStudy() {
  return { ...DEFAULT_STUDY, ...((await db.get('study')) || {}) };
}
export const saveStudy = (s) => db.set('study', s);

export async function loadSavedStudies() {
  return (await db.get('savedStudies')) || [];
}
export const saveSavedStudies = (list) => db.set('savedStudies', list);

// Tahmini harcama kaydı: { total, days: { 'YYYY-MM-DD': usd } }
export const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
export async function loadCosts() {
  return (await db.get('costs')) || { total: 0, days: {} };
}
export async function addCost(usd) {
  if (!usd) return;
  const c = await loadCosts();
  const k = today();
  c.days[k] = (c.days[k] || 0) + usd;
  c.total += usd;
  await db.set('costs', c);
}

// Yedekleme: tüm verileri tek JSON dosyasına çevir / geri yükle
export async function exportAll() {
  const keys = await db.keys();
  const data = {};
  for (const k of keys) data[k] = await db.get(k);
  return { app: 'ingilizce-ogretmen', version: 1, exportedAt: new Date().toISOString(), data };
}

export async function importAll(backup) {
  if (!backup || backup.app !== 'ingilizce-ogretmen' || !backup.data) {
    throw new Error('Bu dosya bu uygulamanın yedeği değil.');
  }
  await db.clear();
  for (const [k, v] of Object.entries(backup.data)) await db.set(k, v);
}

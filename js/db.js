// Telefondaki veri deposu (IndexedDB, basit anahtar-değer)

const DB_NAME = 'cumle-atolyesi';
const OLD_DB = 'ingilizce-ogretmen'; // eski uygulama: ilk açılışta silinir

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp = null;
async function tx(mode, fn) {
  dbp = dbp || open();
  const d = await dbp;
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const r = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  get: (k) => tx('readonly', (s) => s.get(k)),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  del: (k) => tx('readwrite', (s) => s.delete(k)),
  keys: () => tx('readonly', (s) => s.getAllKeys()),
  clear: () => tx('readwrite', (s) => s.clear()),
};

// Eski uygulamanın verilerini bir kez sil
export async function removeOldApp() {
  if (localStorage.getItem('oldRemoved')) return;
  try { indexedDB.deleteDatabase(OLD_DB); } catch { /* yok */ }
  localStorage.setItem('oldRemoved', '1');
}

export const DEFAULT_SETTINGS = {
  provider: 'openai', // 'openai' | 'anthropic'
  openaiKey: '',
  openaiModel: 'gpt-5.6-terra',
  anthropicKey: '',
  anthropicModel: 'claude-sonnet-5-5',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'marin',
};

export async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...((await db.get('settings')) || {}) };
}
export const saveSettings = (s) => db.set('settings', s);

// Yerel tarih (Türkiye saati) YYYY-AA-GG
export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- Maliyet ----------
export async function loadCosts() {
  return (await db.get('costs')) || { total: 0, days: {} };
}
export async function addCost(usd) {
  if (!usd) return;
  const c = await loadCosts();
  c.total += usd;
  c.days[today()] = (c.days[today()] || 0) + usd;
  await db.set('costs', c);
}

// ---------- Yedek ----------
export async function exportAll() {
  const keys = await db.keys();
  const data = {};
  for (const k of keys) data[k] = await db.get(k);
  if (data.settings) { data.settings = { ...data.settings, openaiKey: '', anthropicKey: '' }; }
  return { app: 'cumle-atolyesi', version: 1, exportedAt: new Date().toISOString(), data };
}

export async function importAll(backup) {
  if (!backup || backup.app !== 'cumle-atolyesi' || !backup.data) throw new Error('Bu dosya Cümle Atölyesi yedeği değil.');
  const keep = await loadSettings();
  await db.clear();
  for (const [k, v] of Object.entries(backup.data)) await db.set(k, v);
  const s = await loadSettings();
  s.openaiKey = keep.openaiKey;
  s.anthropicKey = keep.anthropicKey;
  await saveSettings(s);
}

// OpenAI API ile konuşan yardımcı fonksiyonlar.
// Aşama 1: sadece anahtar testi. Sonraki aşamalarda ders fonksiyonları eklenecek.

const BASE = 'https://api.openai.com/v1';

export async function testApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) return { ok: false, message: 'Önce bir API anahtarı gir.' };
  try {
    const res = await fetch(BASE + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey.trim() },
    });
    if (res.ok) return { ok: true, message: 'Bağlantı çalışıyor.' };
    if (res.status === 401) return { ok: false, message: 'Anahtar geçersiz (401). Kopyalarken eksik kalmış olabilir.' };
    if (res.status === 429) return { ok: false, message: 'Kota veya kredi sorunu (429). Bakiyeni kontrol et.' };
    return { ok: false, message: 'Beklenmeyen cevap: ' + res.status };
  } catch (e) {
    return { ok: false, message: 'İnternete bağlanılamadı: ' + e.message };
  }
}

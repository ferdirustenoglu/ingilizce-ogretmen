// Kelime kartları: anlam, kelime türü, halleri, örnek cümle (bir kez üretilir, saklanır)
import { db, addCost } from './db.js';
import { chatJSON } from './openai.js';
import { playText } from './audio.js';

export const loadWordCards = async () => (await db.get('wordCards')) || {};

async function makeCards(settings, words, level) {
  const r = await chatJSON(settings, [
    {
      role: 'system',
      content: `You make vocabulary cards for an adult Turkish learner of English (level ${level}). For each English word give the most common meaning(s) in Turkish and a simple, natural example sentence suitable for the level.
Return ONLY JSON: {"cards": [{"word": "the word as given", "tr": "Türkçe anlam(lar), kısa", "pos_tr": "kelime türü Türkçe (fiil, isim, sıfat, zarf...)", "forms": "for verbs: V1 – V2 – V3 (e.g. go – went – gone); for nouns: plural if irregular; else empty", "example_en": "...", "example_tr": "..."}]}`,
    },
    { role: 'user', content: words.join('\n') },
  ], 1800, settings.models.analysis);
  await addCost(r.cost);
  return (r.data.cards || []).filter((c) => c && c.word);
}

/**
 * Kelime kartlarını kutuya çizer; eksik kartları üretir.
 * c: { state, esc, toast }, box: kapsayıcı öğe
 */
export async function renderWordCards(c, box, words) {
  const { state, esc, toast } = c;
  const cards = await loadWordCards();
  const missing = words.filter((w) => !cards[w.toLowerCase()]);

  const draw = (loading) => {
    box.innerHTML = words.map((w) => {
      const k = w.toLowerCase();
      const cd = cards[k];
      if (!cd) {
        return `<article class="wcard"><div class="row-between"><span class="wc-word">${esc(w)}</span></div><p class="small">${loading ? 'Hazırlanıyor…' : 'Kart hazırlanamadı.'}</p></article>`;
      }
      return `<article class="wcard">
        <div class="row-between" style="align-items:flex-start">
          <div style="display:flex; flex-direction:column; gap:2px; min-width:0">
            <span class="wc-word">${esc(cd.word)}</span>
            <span class="small">${esc(cd.pos_tr || '')}${cd.forms ? ' · ' + esc(cd.forms) : ''}</span>
          </div>
          <button type="button" class="replay" data-wsay="${esc(cd.word)}" aria-label="${esc(cd.word)} kelimesini dinle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button>
        </div>
        <p class="wc-tr">${esc(cd.tr || '')}</p>
        ${cd.example_en ? `<div class="ml-ex">
          <div style="flex:1; min-width:0"><p class="ml-en" style="font-size:14px">${esc(cd.example_en)}</p><p class="ml-tr">${esc(cd.example_tr || '')}</p></div>
          <button type="button" class="replay" data-wsay="${esc(cd.example_en)}" aria-label="Örnek cümleyi dinle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button>
        </div>` : ''}
        <a class="small" href="#pron/${encodeURIComponent(cd.word)}" style="font-weight:600; text-decoration:none">Telaffuzunu çalış →</a>
      </article>`;
    }).join('');
    box.querySelectorAll('[data-wsay]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await playText(state.settings, state.profile.level, b.dataset.wsay); } catch (e) { toast(e.message); }
      b.disabled = false;
    }));
  };

  if (!missing.length) { draw(false); return; }
  if (!state.settings.apiKey) { draw(false); toast('Kart hazırlamak için önce API anahtarını gir.'); return; }
  draw(true);
  try {
    // Uzun listeleri 15'erli parçalar hâlinde hazırla
    for (let i = 0; i < missing.length; i += 15) {
      const made = await makeCards(state.settings, missing.slice(i, i + 15), state.profile.level);
      const fresh = await loadWordCards();
      made.forEach((cd) => { fresh[String(cd.word).toLowerCase()] = cd; cards[String(cd.word).toLowerCase()] = cd; });
      // Model kelimeyi farklı yazdıysa sıradaki kelimeyle eşleştir
      missing.slice(i, i + 15).forEach((w, j) => {
        const k = w.toLowerCase();
        if (!cards[k] && made[j]) { cards[k] = made[j]; fresh[k] = made[j]; }
      });
      await db.set('wordCards', fresh);
      if (box.isConnected) draw(i + 15 < missing.length);
    }
  } catch (e) {
    toast(e.message);
    if (box.isConnected) draw(false);
  }
}

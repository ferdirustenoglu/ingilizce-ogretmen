// Uygulama girişi ve yönlendirme

import { loadSettings, removeOldApp } from './db.js';
import { stopAudio } from './ai.js';
import { renderHome, renderMap, renderCard, renderMistakes, renderSettings } from './screens.js';
import { renderPractice, renderSummary, stopRecording } from './practice.js';

const app = document.getElementById('app');
const state = { settings: null };
const ctx = {
  app,
  state,
  reload: async () => { state.settings = await loadSettings(); },
};

const ROUTES = {
  home: () => renderHome(ctx),
  harita: () => renderMap(ctx),
  kart: (sub) => renderCard(ctx, sub),
  hatalar: () => renderMistakes(ctx),
  ayarlar: () => renderSettings(ctx),
  calis: () => renderPractice(ctx),
  ozet: () => renderSummary(ctx),
};
const TAB_OF = { kart: 'harita', calis: '', ozet: '' };

async function route() {
  const [name, sub] = (location.hash || '#home').slice(1).split('/');
  const render = ROUTES[name] || ROUTES.home;
  stopAudio();
  stopRecording();
  const tab = name in TAB_OF ? TAB_OF[name] : name;
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.classList.toggle('focus-mode', name === 'calis');
  try {
    await render(sub);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="page"><div class="notice">Bir hata oluştu: ${String(e.message || e)}</div><a class="btn" href="#home">Ana sayfa</a></div>`;
  }
  window.scrollTo(0, 0);
}

(async function start() {
  await removeOldApp();
  await ctx.reload();
  window.addEventListener('hashchange', route);
  route();
})();

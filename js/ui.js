// Ortak arayüz yardımcıları

import { ROLE_LABELS } from './learn.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

export const IC = {
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  speaker: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  lock: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  chat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  flame: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-4 5-4 8-1-1-2-2-2-4-2 2-3 5-3 8 0 4 3 7 7 7z"/></svg>',
  flag: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  bulb: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
};

export function header({ back, title, sub, right = '' }) {
  return `
  <div class="head">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Geri">${IC.back}</a>` : ''}
    <div class="head-t">${title}${sub ? `<span class="small">${esc(sub)}</span>` : ''}</div>
    ${right}
  </div>`;
}

export const patternChips = (p) => `<span class="chips"><span class="chip-tr">${esc(p.tr)}</span><span class="chip-ar" aria-hidden="true">→</span><span class="chip-en">${esc(p.en)}</span></span>`;

// Öğe kutuları. mode: 'plain' | 'check' (✓/✗) | 'hint' (öğe adları)
export function blocks(parts, mode = 'plain') {
  return `<div class="blk-row">${parts.map((p) => {
    const bad = mode === 'check' && p.ok === false;
    const label = ROLE_LABELS[p.r] || '';
    const text = mode === 'hint' ? esc(label || '…') : esc(p.t);
    return `<span class="blk r-${p.r}${bad ? ' bad' : ''}"><span>${p.hl ? `<u>${text}</u>` : text}</span>${mode !== 'hint' && label ? `<small>${esc(label)}${mode === 'check' ? (bad ? ' ✗' : ' ✓') : ''}</small>` : ''}</span>`;
  }).join('')}</div>`;
}

// Türkçe cümlede kalıbı taşıyan kısmı vurgula
export function highlight(tr, focus) {
  if (!focus) return esc(tr);
  const i = tr.indexOf(focus);
  if (i < 0) return esc(tr);
  return esc(tr.slice(0, i)) + `<mark>${esc(focus)}</mark>` + esc(tr.slice(i + focus.length));
}

export const bar = (pct, cls = '') => `<div class="bar ${cls}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

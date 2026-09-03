/** Home page: the niche grid, the personalisable row and the best sellers. */

import { NICHES, nicheCount, personalisable, featured } from './catalog.js';
import { chrome, cardGrid, escapeHtml, CHECK } from './ui.js';

chrome('home');

// The hero's ticks are markup-free in the HTML so the icon lives in one place.
document.querySelectorAll('[data-check]').forEach((el) => el.insertAdjacentHTML('afterbegin', CHECK));

document.querySelector('[data-niches]').innerHTML = NICHES.map((n) => `
<a class="niche-card" href="collection.html?c=${n.id}" style="--tone:${n.tone}">
  <div class="niche-emoji">${n.emoji}</div>
  <h3>${escapeHtml(n.title)}</h3>
  <p>${escapeHtml(n.tagline)}</p>
  <div class="meta">
    ${nicheCount(n.id)} peças
    ${n.id === 'bimby' || n.id === 'lego' ? '<span class="tag-perso">Personalizável</span>' : ''}
  </div>
</a>`).join('');

document.querySelector('[data-perso]').innerHTML = cardGrid(personalisable());
document.querySelector('[data-featured]').innerHTML = cardGrid(featured().slice(0, 8));

/**
 * Collection page — one niche, a search result, or everything.
 *
 * Which of the three it is comes from the query string, the way a Shopify
 * theme reads /collections/<handle> and /search:
 *
 *   ?c=<niche>   the niche's products
 *   ?q=<term>    search results
 *   ?perso=1     everything personalisable, across niches
 *   (nothing)    the whole catalogue
 *
 * Sorting stays in the URL too, so a sorted list can be linked and the back
 * button returns to it.
 */

import { PRODUCTS, byNiche, niche, personalisable, search } from './catalog.js';
import { chrome, cardGrid, escapeHtml } from './ui.js';

const params = new URLSearchParams(location.search);
const nicheId = params.get('c');
const term = (params.get('q') || '').trim();
const persoOnly = params.has('perso');
const n = nicheId ? niche(nicheId) : null;

chrome(n ? n.id : '');

let list;
let head;

if (term) {
  list = search(term);
  head = {
    tone: '#1c6fd4',
    crumb: 'Pesquisa',
    title: `“${term}”`,
    blurb: list.length
      ? 'Resultados em todo o catálogo.'
      : 'Sem resultados. Tente outra palavra, ou percorra as categorias no topo.',
  };
} else if (persoOnly) {
  list = personalisable();
  head = {
    tone: '#c2410c',
    crumb: 'Personalizáveis',
    title: 'Peças personalizáveis',
    blurb: 'Estas abrem o gerador antes da compra: escreve, vê o resultado em 3D e só depois paga. '
      + 'Para já, Bimby e tijolos — as restantes categorias vendem-se como estão.',
  };
} else if (n) {
  list = byNiche(n.id);
  head = { tone: n.tone, crumb: n.title, title: n.title, blurb: n.blurb, emoji: n.emoji };
} else {
  list = PRODUCTS;
  head = {
    tone: '#1c6fd4',
    crumb: 'Catálogo',
    title: 'Todo o catálogo',
    blurb: 'Tudo o que esta oficina imprime, em sete categorias.',
  };
}

document.title = `${head.title} — FormCAT`;

document.querySelector('[data-head]').style.setProperty('--tone', head.tone);
document.querySelector('[data-head]').innerHTML = `
<div class="wrap">
  <div class="crumbs"><a href="index.html">Início</a><span>/</span><span>${escapeHtml(head.crumb)}</span></div>
  <h1>${head.emoji ? `${head.emoji} ` : ''}${escapeHtml(head.title)}</h1>
  <p>${escapeHtml(head.blurb)}</p>
  ${n ? `<div class="chips">
    <button class="chip" data-filter="all" aria-pressed="true">Todos</button>
    <button class="chip" data-filter="perso" aria-pressed="false">Personalizáveis</button>
    <button class="chip" data-filter="plain" aria-pressed="false">Prontos a enviar</button>
  </div>` : ''}
</div>`;

const grid = document.querySelector('[data-grid]');
const countEl = document.querySelector('[data-count]');
const sortEl = document.querySelector('[data-sort]');
sortEl.value = params.get('sort') || 'rel';

let filter = 'all';

function paint() {
  let rows = list.slice();
  if (filter === 'perso') rows = rows.filter((p) => p.customizer);
  if (filter === 'plain') rows = rows.filter((p) => !p.customizer);

  const sort = sortEl.value;
  if (sort === 'asc') rows.sort((a, b) => a.price - b.price);
  else if (sort === 'desc') rows.sort((a, b) => b.price - a.price);
  else if (sort === 'rating') rows.sort((a, b) => b.rating - a.rating);
  else rows.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));

  countEl.textContent = rows.length === 1 ? '1 peça' : `${rows.length} peças`;
  grid.innerHTML = rows.length
    ? cardGrid(rows)
    : '<div class="empty-state">Nada nesta seleção.</div>';
  grid.classList.toggle('grid', true);
}

sortEl.addEventListener('change', () => {
  const next = new URLSearchParams(location.search);
  next.set('sort', sortEl.value);
  history.replaceState(null, '', `?${next}`);
  paint();
});

document.querySelector('[data-head]').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const b of chip.parentElement.children) b.setAttribute('aria-pressed', String(b === chip));
  paint();
});

paint();

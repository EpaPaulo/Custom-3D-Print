/**
 * Shared UI: money, product artwork, header, footer, cards, toast.
 *
 * There are no photographs in this repository and inventing them would mean
 * shipping binaries that misrepresent parts nobody has printed yet, so every
 * product's image is drawn here as an SVG — build plate, layer lines, and the
 * niche's glyph — seeded from the handle so a product always looks the same.
 * Swapping in real photos later is one field on the catalogue entry and one
 * branch in `art()`.
 */

import { NICHES, niche } from './catalog.js';
import { cart } from './cart.js';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const EUR = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

/** Cents in, "29,90 €" out. Prices are integers everywhere else. */
export const money = (cents) => EUR.format(cents / 100);

export const stars = (rating) => {
  const full = Math.round(rating);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
};

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Stable small hash, so a product's artwork never shuffles between loads. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Product artwork
// ---------------------------------------------------------------------------

/**
 * A product image, as SVG markup.
 *
 * @param {object} p        catalogue entry
 * @param {object} [opts]
 * @param {number} [opts.view]   0..2 — the "angles" the gallery flips between
 * @param {string} [opts.colour] hex of the chosen variant, so the part changes colour
 */
export function art(p, opts = {}) {
  const { view = 0, colour = null } = opts;
  const n = niche(p.niche);
  const seed = hash(p.handle + view);
  const tone = n ? n.tone : '#1c6fd4';
  const body = colour || '#2b3038';
  const rot = [-8, 4, 12][view % 3] + ((seed % 5) - 2);
  const rx = 14 + (seed % 3) * 8;
  const w = 210 + (seed % 4) * 14;
  const h = 132 + ((seed >> 3) % 4) * 12;
  const id = `a${seed.toString(36)}`;

  return `
<svg viewBox="0 0 400 300" role="img" aria-label="${escapeHtml(p.title)}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${tone}" stop-opacity=".16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="1"/>
    </linearGradient>
    <linearGradient id="part-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${body}" stop-opacity=".95"/>
      <stop offset="1" stop-color="${body}" stop-opacity=".72"/>
    </linearGradient>
    <pattern id="layers-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${rot})">
      <line x1="0" y1="0" x2="6" y2="0" stroke="#ffffff" stroke-opacity=".13" stroke-width="1.6"/>
    </pattern>
    <filter id="sh-${id}" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#0f1216" flood-opacity=".22"/>
    </filter>
  </defs>

  <rect width="400" height="300" fill="url(#bg-${id})"/>

  <!-- build plate -->
  <g stroke="${tone}" stroke-opacity=".18" stroke-width="1">
    <path d="M40 232 L360 232"/>
    <path d="M8 262 L392 262"/>
    <path d="M104 210 L64 262"/>
    <path d="M200 210 L200 262"/>
    <path d="M296 210 L336 262"/>
  </g>

  <g transform="translate(200 146) rotate(${rot})" filter="url(#sh-${id})">
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}" fill="url(#part-${id})"/>
    <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}" fill="url(#layers-${id})"/>
    <rect x="${-w / 2 + 9}" y="${-h / 2 + 9}" width="${w - 18}" height="${h - 18}" rx="${Math.max(4, rx - 8)}"
          fill="none" stroke="#ffffff" stroke-opacity=".18"/>
  </g>

  <text x="200" y="150" text-anchor="middle" dominant-baseline="central" font-size="66">${n ? n.emoji : '🧩'}</text>
</svg>`.trim();
}

/** The same artwork as a data URI, for <img> (cart lines, thumbnails). */
export const artDataUri = (p, opts) => `data:image/svg+xml,${encodeURIComponent(art(p, opts))}`;

// ---------------------------------------------------------------------------
// Product card
// ---------------------------------------------------------------------------

export function card(p) {
  const n = niche(p.niche);
  // The card shows the part in its default filament, which is what the product
  // page opens on — so a red plate is red before the shopper touches anything.
  const colour = p.colours[0].hex;
  const sale = p.compareAt && p.compareAt > p.price
    ? `<span class="card-sale">−${Math.round((1 - p.price / p.compareAt) * 100)}%</span>` : '';
  const badge = p.badge ? `<span class="card-badge">${escapeHtml(p.badge)}</span>` : '';
  const was = p.compareAt && p.compareAt > p.price
    ? `<span class="card-was">${money(p.compareAt)}</span>` : '';

  return `
<a class="card" href="product.html?p=${encodeURIComponent(p.handle)}" style="--tone:${n.tone}">
  <div class="card-art">${art(p, { colour })}${badge}${sale}</div>
  <div class="card-body">
    <span class="card-kicker">${escapeHtml(n.short)}</span>
    <h3>${escapeHtml(p.title)}</h3>
    <p class="sub">${escapeHtml(p.subtitle)}</p>
    <div class="card-foot">
      <span class="card-price">${money(p.price)}</span>
      ${was}
      <span class="card-rating"><span class="stars">${stars(p.rating)}</span><b>${p.rating.toFixed(1)}</b></span>
    </div>
  </div>
</a>`;
}

export const cardGrid = (list) => list.map(card).join('');

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const CHECK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 8.5l4 4 8-9"/></svg>';

export { CHECK };

/**
 * Header and footer, rendered from one place so every page carries the same
 * navigation and the same live cart count.
 *
 * @param {string} current  niche id, 'home' or 'cart' — marks the nav item
 */
export function chrome(current = '') {
  const header = document.querySelector('[data-header]');
  const footer = document.querySelector('[data-footer]');

  if (header) {
    header.innerHTML = `
<div class="wrap header-row">
  <a class="brand" href="index.html">Form<em>o</em>ra</a>
  <nav class="main-nav">
    ${NICHES.map((n) => `<a href="collection.html?c=${n.id}"${n.id === current ? ' aria-current="page"' : ''}>${escapeHtml(n.short)}</a>`).join('')}
  </nav>
  <div class="header-tools">
    <form class="search" role="search" action="collection.html">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/>
      </svg>
      <input type="search" name="q" placeholder="Procurar peças" aria-label="Procurar">
    </form>
    <a class="cart-link" href="cart.html">
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M2 2h2l2.2 9.2h8.2L17 5H5"/><circle cx="7.5" cy="15" r="1.3"/><circle cx="14" cy="15" r="1.3"/>
      </svg>
      Carrinho <span class="cart-count" data-cart-count>0</span>
    </a>
  </div>
</div>`;
  }

  if (footer) {
    footer.innerHTML = `
<div class="wrap footer-cols">
  <div>
    <a class="brand" href="index.html">Form<em>o</em>ra</a>
    <p style="margin-top:10px">Peças impressas em 3D por encomenda, em Portugal.
      Personalizadas quando faz sentido — e só quando faz.</p>
    <p><a href="../index.html">Personalizador Bimby ↗</a> · <a href="../lego/index.html">Gerador de placas ↗</a></p>
  </div>
  <div>
    <h4>Categorias</h4>
    <ul>${NICHES.slice(0, 4).map((n) => `<li><a href="collection.html?c=${n.id}">${escapeHtml(n.title)}</a></li>`).join('')}</ul>
  </div>
  <div>
    <h4>Mais</h4>
    <ul>${NICHES.slice(4).map((n) => `<li><a href="collection.html?c=${n.id}">${escapeHtml(n.title)}</a></li>`).join('')}
      <li><a href="collection.html?perso=1">Personalizáveis</a></li></ul>
  </div>
  <div>
    <h4>Ajuda</h4>
    <ul>
      <li><a href="index.html#como">Como funciona</a></li>
      <li><a href="cart.html">Carrinho</a></li>
      <li><a href="index.html#envios">Envios e prazos</a></li>
      <li><a href="index.html#materiais">Materiais</a></li>
    </ul>
  </div>
</div>
<div class="wrap footer-note">
  <span>Loja de demonstração — nenhum pagamento é processado.</span>
  <span>Artigos personalizados: sem direito de livre resolução (Dir. 2011/83/UE, art. 16.º c).</span>
</div>`;
  }

  paintCount();
  window.addEventListener('cart:change', paintCount);
}

function paintCount() {
  const n = cart.count();
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = String(n);
    el.dataset.empty = n ? '0' : '1';
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastEl = null;
let toastTimer = null;

export function toast(html) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.append(toastEl);
  }
  toastEl.innerHTML = html;
  requestAnimationFrame(() => toastEl.classList.add('on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 4200);
}

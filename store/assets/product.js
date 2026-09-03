/**
 * Product page.
 *
 * Two kinds of product share this page, and the difference is one field on the
 * catalogue entry. An ordinary part is picked and bought. A personalisable one
 * cannot be bought until it has been designed, so the buy button waits on the
 * generator: the shopper opens it, designs, comes back with a preview, and
 * only then does the cart accept the line.
 *
 * Blocking the button is the point. A personalised part is unsellable to
 * anyone else, so an order without a design is an order nobody can fill.
 */

import { product, niche, related } from './catalog.js';
import { chrome, cardGrid, art, money, stars, escapeHtml, toast, CHECK } from './ui.js';
import { cart, thumbnail } from './cart.js';
import { CustomizerModal, appFor, API_BASE } from './customizer.js';

// Declared before render() runs: `let` bindings are not hoisted into scope the
// way `function` declarations are, and render() assigns both.
let chosen = null;   // the colour variant on screen
let design = null;   // the finished personalisation, when there is one

const handle = new URLSearchParams(location.search).get('p');
const p = product(handle);
const root = document.querySelector('[data-product]');

if (!p) {
  chrome('');
  root.innerHTML = `
    <div class="empty-state" style="margin:60px 0">
      Não encontrámos essa peça. <a href="index.html">Voltar ao início</a>.
    </div>`;
} else {
  render(p);
}

function render(p) {
  const n = niche(p.niche);
  chrome(n.id);
  document.title = `${p.title} — epalfer.3d`;

  const app = appFor(p.customizer);
  const was = p.compareAt && p.compareAt > p.price
    ? `<span class="price-was">${money(p.compareAt)}</span>` : '';

  root.innerHTML = `
<div class="product-layout" style="--tone:${n.tone}">

  <div class="gallery">
    <div class="crumbs" style="margin-bottom:14px">
      <a href="index.html">Início</a><span>/</span>
      <a href="collection.html?c=${n.id}">${escapeHtml(n.title)}</a><span>/</span>
      <span>${escapeHtml(p.title)}</span>
    </div>
    <div class="gallery-main" data-main>${art(p, { view: 0 })}</div>
    <div class="gallery-thumbs" data-thumbs>
      ${[0, 1, 2].map((v) => `
        <button type="button" data-view="${v}" aria-pressed="${v === 0}"
                aria-label="Vista ${v + 1}">${art(p, { view: v })}</button>`).join('')}
    </div>
  </div>

  <div class="buybox">
    <h1>${escapeHtml(p.title)}</h1>
    <p class="sub">${escapeHtml(p.subtitle)}</p>

    <div class="price-row"><span class="price">${money(p.price)}</span>${was}</div>
    <p class="vat">IVA incluído. Portes calculados no checkout.
      <span style="white-space:nowrap">${stars(p.rating)} ${p.rating.toFixed(1)} · ${p.reviews} avaliações</span>
    </p>

    <p style="color:var(--ink-2);font-size:15px;margin:0 0 20px">${escapeHtml(p.blurb)}</p>

    ${p.customizer ? persoBox(p, app) : ''}

    <div class="opt">
      <span class="opt-label">Cor <span class="chosen" data-colour-label>${escapeHtml(p.colours[0].label)}</span></span>
      <div class="swatches" data-colours>
        ${p.colours.map((c, i) => `
          <button type="button" class="swatch" aria-pressed="${i === 0}"
                  data-hex="${c.hex}" data-label="${escapeHtml(c.label)}">
            <i class="dot" style="background:${c.hex}"></i>${escapeHtml(c.label)}
          </button>`).join('')}
      </div>
    </div>

    <div class="opt">
      <span class="opt-label">Quantidade</span>
      <div class="qty-row">
        <input class="qty" type="number" value="1" min="1" max="10" data-qty>
        <span style="color:var(--muted);font-size:13.5px">Máximo 10 por encomenda.</span>
      </div>
    </div>

    <button class="btn btn-primary btn-lg btn-block" data-add ${p.customizer ? 'disabled' : ''}>
      ${p.customizer ? 'Personalize primeiro' : 'Adicionar ao carrinho'}
    </button>
    <p class="err" data-err></p>

    <ul class="facts">
      ${p.bullets.map((b) => `<li>${CHECK}<span>${escapeHtml(b)}</span></li>`).join('')}
    </ul>

    <dl class="specs">
      ${Object.entries(p.specs).map(([k, v]) => `
        <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
    </dl>

    ${p.customizer ? `<p class="legal">
      Artigo personalizado, feito à sua medida: nos termos do artigo 16.º, alínea c), da
      Diretiva 2011/83/UE, não se aplica o direito de livre resolução de 14 dias.
      Confirme a pré-visualização antes de comprar.
    </p>` : ''}
  </div>
</div>`;

  wireGallery(p);
  wireColours(p);
  if (p.customizer) wirePersonalisation(p);
  wireAdd(p);
  wireRelated(p);
}

function persoBox(p, app) {
  return `
<div class="perso-box">
  <h2>✨ Esta peça é personalizada por si</h2>
  <p>${app
    ? 'Abra o gerador, escreva o texto ou carregue uma imagem, e veja a peça em 3D antes de comprar.'
    : 'O gerador desta peça ainda não está ligado a esta loja.'}</p>
  <div class="perso-state" data-perso-state>
    <img alt="Pré-visualização do seu desenho" data-perso-img>
    <div>
      <b>Desenho pronto</b>
      <span data-perso-summary></span>
    </div>
  </div>
  <button class="btn btn-tone" type="button" data-personalise>Personalizar agora</button>
</div>`;
}

// -- gallery ----------------------------------------------------------------

function wireGallery(p) {
  const main = root.querySelector('[data-main]');
  root.querySelector('[data-thumbs]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    for (const b of btn.parentElement.children) b.setAttribute('aria-pressed', String(b === btn));
    main.innerHTML = art(p, { view: Number(btn.dataset.view), colour: chosen.hex });
  });
}

// -- colour -----------------------------------------------------------------

function wireColours(p) {
  chosen = p.colours[0];
  root.querySelector('[data-colours]').addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    for (const b of btn.parentElement.children) b.setAttribute('aria-pressed', String(b === btn));
    chosen = { label: btn.dataset.label, hex: btn.dataset.hex };
    root.querySelector('[data-colour-label]').textContent = chosen.label;
    // The artwork is drawn, not photographed, so it can honestly follow the
    // filament the shopper picked.
    const view = Number(root.querySelector('[data-view][aria-pressed="true"]').dataset.view);
    root.querySelector('[data-main]').innerHTML = art(p, { view, colour: chosen.hex });
  });
}

// -- personalisation --------------------------------------------------------

function wirePersonalisation(p) {
  const addBtn = root.querySelector('[data-add]');
  const openBtn = root.querySelector('[data-personalise]');
  const state = root.querySelector('[data-perso-state]');

  const modal = new CustomizerModal({
    product: p,
    onDone: async (result) => {
      design = {
        id: result.id,
        model: result.model,
        summary: result.summary,
        // The cart keeps a small copy; the full-size preview stays with the
        // order backend when there is one.
        thumb: await thumbnail(result.previewPng),
      };
      state.classList.add('on');
      state.querySelector('[data-perso-img]').src = design.thumb || '';
      state.querySelector('[data-perso-summary]').textContent = design.id
        ? `${design.summary} · registado como ${design.id}`
        : design.summary;
      openBtn.textContent = 'Alterar desenho';
      addBtn.disabled = false;
      addBtn.textContent = 'Adicionar ao carrinho';
      root.querySelector('[data-err]').textContent = '';
    },
  });

  openBtn.addEventListener('click', () => modal.open());
}

// -- add to cart ------------------------------------------------------------

function wireAdd(p) {
  const btn = root.querySelector('[data-add]');
  const err = root.querySelector('[data-err]');

  btn.addEventListener('click', () => {
    if (p.customizer && !design) {
      err.textContent = 'Personalize a peça antes de a adicionar ao carrinho.';
      return;
    }
    err.textContent = '';

    cart.add({
      handle: p.handle,
      title: p.title,
      price: p.price,
      colour: chosen.label,
      colourHex: chosen.hex,
      qty: Math.max(1, Math.min(10, Number(root.querySelector('[data-qty]').value) || 1)),
      design,
    });

    toast(`<span>${escapeHtml(p.title)} adicionado.</span> <a href="cart.html">Ver carrinho →</a>`);

    // A personalised design belongs to the line that was just added, so the
    // next one starts from a blank sheet rather than silently reusing it.
    if (p.customizer) {
      design = null;
      root.querySelector('[data-perso-state]').classList.remove('on');
      root.querySelector('[data-personalise]').textContent = 'Personalizar outra';
      btn.disabled = true;
      btn.textContent = 'Personalize primeiro';
    }
  });

  if (API_BASE) {
    err.insertAdjacentHTML('afterend',
      `<p style="color:var(--muted);font-size:12.5px;margin-top:8px">Backend de encomendas: <code>${escapeHtml(API_BASE)}</code></p>`);
  }
}

function wireRelated(p) {
  const rows = related(p.handle, 4);
  if (!rows.length) return;
  document.querySelector('[data-related]').innerHTML = cardGrid(rows);
  document.querySelector('[data-related-band]').hidden = false;
}

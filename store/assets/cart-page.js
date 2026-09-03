/**
 * Cart page, and the end of the journey.
 *
 * The checkout is a stub — this storefront exists to test the experience, not
 * to take money — but everything up to it is real: the lines, the quantities,
 * the personalised previews and the totals all come from what was actually
 * added. Confirming empties the cart and shows an order reference, so the flow
 * can be walked end to end and then walked again.
 */

import { product } from './catalog.js';
import { chrome, artDataUri, money, escapeHtml } from './ui.js';
import { cart } from './cart.js';

chrome('cart');

const root = document.querySelector('[data-cart]');
const SHIPPING = 495;      // cents; free above the threshold
const FREE_OVER = 5000;

function paint() {
  const lines = cart.lines();

  if (!lines.length) {
    root.innerHTML = `
      <div class="empty-state" style="margin:26px 0 70px">
        <p style="margin:0 0 16px">O carrinho está vazio.</p>
        <a class="btn btn-primary" href="index.html">Ver categorias</a>
      </div>`;
    return;
  }

  const subtotal = cart.subtotal();
  const shipping = subtotal >= FREE_OVER ? 0 : SHIPPING;
  const hasPerso = lines.some((l) => l.design);

  root.innerHTML = `
<div class="cart-layout">
  <div>
    ${lines.map(lineHtml).join('')}
    <p style="margin-top:18px"><a href="index.html" style="color:var(--accent);font-weight:600">← Continuar a comprar</a></p>
  </div>

  <aside class="summary">
    <h2>Resumo</h2>
    <div class="row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <div class="row"><span>Portes</span><span>${shipping ? money(shipping) : 'Grátis'}</span></div>
    <div class="row total"><span>Total</span><span>${money(subtotal + shipping)}</span></div>
    <button class="btn btn-primary btn-lg btn-block" style="margin-top:16px" data-checkout>
      Finalizar compra
    </button>
    <p class="note">
      ${shipping ? `Portes grátis acima de ${money(FREE_OVER)}.` : 'Portes grátis aplicados.'}
      Produção em 3–5 dias úteis.
    </p>
    ${hasPerso ? `<p class="note">
      Tem peças personalizadas: o desenho é revisto por nós antes de ir para a impressora e,
      sendo feito à sua medida, não tem direito de livre resolução.
    </p>` : ''}
    <p class="note">Demonstração — nenhum pagamento é processado.</p>
  </aside>
</div>`;
}

function lineHtml(l) {
  const p = product(l.handle);
  // A personalised line shows what was designed; everything else shows the part.
  const image = l.design && l.design.thumb
    ? l.design.thumb
    : (p ? artDataUri(p, { colour: l.colourHex }) : '');

  return `
<div class="line" data-line="${l.id}">
  <div class="line-art"><img src="${image}" alt="${escapeHtml(l.title)}"></div>
  <div>
    <h3><a href="product.html?p=${encodeURIComponent(l.handle)}">${escapeHtml(l.title)}</a></h3>
    <div class="meta">Cor: ${escapeHtml(l.colour)} · ${money(l.price)} / un.</div>
    ${l.design ? `<span class="perso">✨ ${escapeHtml(l.design.summary || 'Personalizado')}${
      l.design.id ? ` · ${escapeHtml(l.design.id)}` : ''}</span>` : ''}
  </div>
  <div class="line-actions">
    <span class="money">${money(l.price * l.qty)}</span>
    <input class="qty" type="number" min="1" max="10" value="${l.qty}" data-qty aria-label="Quantidade">
    <button class="link-danger" data-remove type="button">Remover</button>
  </div>
</div>`;
}

root.addEventListener('input', (e) => {
  const input = e.target.closest('[data-qty]');
  if (!input) return;
  cart.setQty(e.target.closest('[data-line]').dataset.line, input.value);
});

root.addEventListener('click', (e) => {
  if (e.target.closest('[data-remove]')) {
    cart.remove(e.target.closest('[data-line]').dataset.line);
    return;
  }
  if (e.target.closest('[data-checkout]')) checkout();
});

function checkout() {
  const lines = cart.lines();
  const total = cart.subtotal() + (cart.subtotal() >= FREE_OVER ? 0 : SHIPPING);
  const ref = `FM-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const perso = lines.filter((l) => l.design).length;

  cart.clear();
  root.innerHTML = `
<div class="order-done">
  <h2>Encomenda registada</h2>
  <p>Referência <code>${ref}</code> · ${lines.length} ${lines.length === 1 ? 'linha' : 'linhas'} · ${money(total)}</p>
  ${perso ? `<p>${perso} ${perso === 1 ? 'peça personalizada segue' : 'peças personalizadas seguem'} para revisão do desenho antes de imprimir.</p>` : ''}
  <p style="color:var(--muted);margin-top:14px">
    Isto é uma demonstração: nada foi cobrado e nenhuma encomenda foi criada no Shopify.
  </p>
  <a class="btn btn-primary" style="margin-top:16px" href="index.html">Voltar à loja</a>
</div>`;
}

window.addEventListener('cart:change', () => {
  // The checkout screen replaces the cart; a clear() from it must not repaint
  // the empty state over the confirmation.
  if (!root.querySelector('.order-done')) paint();
});

paint();

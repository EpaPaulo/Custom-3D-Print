/**
 * The personalisation step.
 *
 * A personalised product does not sell from a photograph: the shopper has to
 * design the thing first. This opens the design app for a product in a modal
 * over the product page, waits for a design, and hands it back to the page as
 * something a cart line can hold.
 *
 * Two apps are wired in, and both speak the same contract as the TM7
 * configurator already does:
 *
 *   app -> page   { type: 'bimby:ready'  | 'bimby:change', hasDesign, mode, model }
 *   page -> app   { type: 'bimby:getDesign', requestId }
 *   app -> page   { type: 'bimby:design', requestId, design }
 *
 * Speaking one protocol is what keeps this file from growing a branch per
 * niche: a third personalisable category is an entry in APPS, not new code
 * here. (The message names are the configurator's own, kept as they are — a
 * rename would be a change on both sides for no gain.)
 */

const READY = ['bimby:ready', 'bimby:change'];

/**
 * Where each design app lives.
 *
 * `bimby` is the real configurator in this repository, opened in shop mode:
 * that drops its header, the parametric generator and every route to the STL,
 * because handing a shopper the model would give away the product.
 *
 * `lego` is the brick generator, which is still a mock in this repository —
 * `?legoApp=<url>` on the storefront points it at the real one when it exists,
 * without touching this file.
 */
const params = new URLSearchParams(location.search);

const APPS = {
  bimby: {
    label: 'Personalizador Bimby',
    hint: 'Escreva o texto ou carregue uma imagem. A pré-visualização é o que será impresso.',
    url: (model) => `../index.html?shop=1&model=${encodeURIComponent(model || 'cover')}`,
  },
  lego: {
    label: 'Gerador de tijolos',
    hint: 'Escreva o nome e escolha as cores. Cada letra é montada em pinos de 8 mm.',
    url: (model) => {
      const base = params.get('legoApp') || 'lego-customizer.html';
      const join = base.includes('?') ? '&' : '?';
      return `${base}${join}shop=1&model=${encodeURIComponent(model || 'nameplate')}`;
    },
  },
};

export const appFor = (spec) => (spec && APPS[spec.app]) || null;

/** The order backend, when one is running. `?api=` points at it. */
export const API_BASE = (params.get('api') || '').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export class CustomizerModal {
  /**
   * @param {object} opts
   * @param {object} opts.product   catalogue entry (must have `customizer`)
   * @param {(design: object) => void} opts.onDone  called with the finished design
   */
  constructor({ product, onDone }) {
    this.product = product;
    this.onDone = onDone;
    this.spec = product.customizer;
    this.app = appFor(this.spec);
    this.ready = false;
    this.el = null;
    this.onMessage = this.onMessage.bind(this);
  }

  open() {
    if (!this.el) this.build();
    this.el.classList.add('on');
    document.body.style.overflow = 'hidden';
    window.addEventListener('message', this.onMessage);
    this.frame.focus();
  }

  close() {
    if (!this.el) return;
    this.el.classList.remove('on');
    document.body.style.overflow = '';
    window.removeEventListener('message', this.onMessage);
  }

  build() {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = `
<div class="modal-card" role="dialog" aria-modal="true" aria-label="Personalizar ${this.product.title}">
  <div class="modal-head">
    <h2>Personalizar — ${this.product.title}</h2>
    <span class="step">${this.app ? this.app.label : 'Gerador'}</span>
    <button class="btn btn-sm" data-close type="button">Fechar</button>
  </div>
  <div class="modal-body"></div>
  <div class="modal-foot">
    <span class="hint">${this.app ? this.app.hint : ''}</span>
    <p class="err" data-err></p>
    <button class="btn btn-primary" data-use type="button" disabled>A carregar…</button>
  </div>
</div>`;
    document.body.append(el);

    const body = el.querySelector('.modal-body');
    if (this.app) {
      body.innerHTML = `<iframe title="Personalizador" src="${this.app.url(this.spec.model)}"></iframe>`;
      this.frame = body.querySelector('iframe');
    } else {
      // A catalogue entry can name an app that is not wired up yet. Say so
      // plainly rather than opening an empty box.
      body.innerHTML = `<div class="notwired"><div>
        <p>O gerador <b>${this.spec.app}</b> ainda não está ligado a esta loja.</p>
        <p><code>store/assets/customizer.js → APPS.${this.spec.app}</code></p>
      </div></div>`;
    }

    this.useBtn = el.querySelector('[data-use]');
    this.errEl = el.querySelector('[data-err]');
    el.querySelector('[data-close]').addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.classList.contains('on')) this.close();
    });
    this.useBtn.addEventListener('click', () => this.finish());

    this.el = el;
  }

  onMessage(event) {
    const msg = event.data;
    if (!msg || !READY.includes(msg.type)) return;
    if (this.frame && event.source !== this.frame.contentWindow) return;
    this.ready = true;
    this.useBtn.disabled = false;
    this.useBtn.textContent = 'Usar este desenho';
  }

  /** Ask the app for the design, then hand it to the page. */
  async finish() {
    this.errEl.textContent = '';
    const label = this.useBtn.textContent;
    this.useBtn.disabled = true;
    this.useBtn.textContent = 'A guardar…';
    try {
      const design = await requestDesign(this.frame);
      if (!design) throw new Error('Adicione texto ou uma imagem antes de continuar.');
      if (design.config && design.config.mode && design.config.mode !== 'template') {
        throw new Error('Só os modelos padrão podem ser encomendados.');
      }
      const id = await saveDesign(design);
      this.onDone({
        id,
        model: (design.config && design.config.model) || this.spec.model || null,
        summary: summarise(design),
        previewPng: design.previewPng || null,
      });
      this.close();
    } catch (err) {
      this.errEl.textContent = err.message;
    } finally {
      this.useBtn.disabled = false;
      this.useBtn.textContent = label;
    }
  }
}

/** Ask across the iframe boundary, and give up rather than hanging forever. */
function requestDesign(frame) {
  const target = frame && frame.contentWindow;
  if (!target) throw new Error('O personalizador ainda não está pronto.');

  return new Promise((resolve, reject) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('O personalizador não respondeu.'));
    }, 15000);

    function onMessage(event) {
      const msg = event.data;
      if (!msg || msg.type !== 'bimby:design' || msg.requestId !== requestId) return;
      cleanup();
      resolve(msg.design);
    }
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    }

    window.addEventListener('message', onMessage);
    target.postMessage({ type: 'bimby:getDesign', requestId }, '*');
  });
}

/**
 * Hand the design to the order backend if one is running.
 *
 * With `?api=` unset — the usual way to try this storefront — the design stays
 * in the browser and the cart carries the thumbnail alone. That is enough to
 * walk the whole purchase, and it is honest about what it is: nothing was
 * filed anywhere, so nothing can be printed.
 */
async function saveDesign(design) {
  if (!API_BASE) return null;
  const res = await fetch(`${API_BASE}/api/designs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: design.config,
      maskPng: design.maskPng,
      previewPng: design.previewPng,
    }),
  });
  if (!res.ok) throw new Error(`O serviço de desenhos recusou (${res.status}).`);
  const data = await res.json();
  if (!data || !data.id) throw new Error('O serviço de desenhos não devolveu um id.');
  return data.id;
}

/** One line describing the design, for the cart and the order summary. */
function summarise(design) {
  if (design.summary) return design.summary;
  const layers = (design.config && design.config.layers) || [];
  const texts = layers.map((l) => l.text).filter(Boolean);
  if (texts.length) return `“${texts.join(' ')}”`;
  const images = layers.filter((l) => l.type === 'image').length;
  if (images) return images === 1 ? '1 imagem' : `${images} imagens`;
  return 'Desenho personalizado';
}

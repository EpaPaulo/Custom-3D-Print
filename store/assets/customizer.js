/**
 * The personalisation step.
 *
 * A personalised product does not sell from a photograph: the shopper has to
 * design the thing first. This opens the design app for a product in a modal
 * over the product page, waits for a design, and hands it back to the page as
 * something a cart line can hold.
 *
 * Two apps are wired in, and they are two separate apps with two separate
 * protocols — the Bimby cover personaliser (`bimby:*`) and the LEGO plate
 * generator (`plate:*`). Rather than teach the modal both, each entry in APPS
 * declares its own message names and how to read a design out of it, so the
 * page above knows only "a design arrived". A third generator is an entry
 * here, not new code on any page.
 */

/**
 * Where each design app lives, and how to talk to it.
 *
 * `ready`   the message an app broadcasts when it has something to sell
 * `ask`/`reply`  the request/response pair for fetching the finished design
 * `read`    turns that app's design payload into the shape the cart stores
 *
 * Both apps run in `?shop=1`, which is each one's own mode for dropping the
 * header and every route to the STL: in a shop the file is the product.
 */
const APPS = {
  bimby: {
    label: 'Personalizador Bimby',
    hint: 'Escreva o texto ou carregue uma imagem. A pré-visualização é o que será impresso.',
    url: (model) => `../index.html?shop=1&model=${encodeURIComponent(model || 'cover')}`,
    ready: ['bimby:ready', 'bimby:change'],
    ask: 'bimby:getDesign',
    reply: 'bimby:design',
    read(design, spec) {
      if (design.config && design.config.mode && design.config.mode !== 'template') {
        // Custom sizes are a design tool, not a product: the shop prints the
        // supplied models, at the measurements that make them fit the machine.
        throw new Error('Só os modelos padrão podem ser encomendados.');
      }
      const layers = (design.config && design.config.layers) || [];
      const texts = layers.map((l) => l.text).filter(Boolean);
      const images = layers.filter((l) => l.type === 'image').length;
      return {
        model: (design.config && design.config.model) || spec.model || null,
        summary: texts.length
          ? `“${texts.join(' ')}”`
          : (images ? `${images} ${images === 1 ? 'imagem' : 'imagens'}` : 'Desenho personalizado'),
        previewPng: design.previewPng || null,
        // The mask is what the order backend turns back into geometry.
        payload: { config: design.config, maskPng: design.maskPng },
      };
    },
  },

  lego: {
    label: 'Gerador de placas',
    hint: 'Escolha a forma e o tamanho em pinos. As medidas seguem a grelha de 8 mm.',
    url: () => '../lego/index.html?shop=1',
    ready: ['plate:changed'],
    ask: 'plate:getDesign',
    reply: 'plate:design',
    read(design, spec) {
      const s = design.spec || {};
      // One decimal, because that is how the generator states them: a plate is
      // n × 8 mm minus the clearance, and rounding hides the clearance.
      const mm = design.size ? `${design.size.x.toFixed(1)} × ${design.size.y.toFixed(1)} mm` : '';
      const shape = s.shape === 'text' && s.char ? `Letra “${s.char}”` : SHAPE_LABELS[s.shape] || 'Placa';
      return {
        model: s.shape || spec.model || null,
        summary: [shape, `${s.width} × ${s.depth} pinos`, mm].filter(Boolean).join(' · '),
        previewPng: design.previewPng || null,
        // The plate's spec *is* the design: the backend builds the mesh from it.
        payload: { spec: design.spec, studs: design.studs },
      };
    },
  },
};

/** Shape names, kept here so the store does not import the generator's modules. */
const SHAPE_LABELS = {
  rect: 'Retângulo', ellipse: 'Círculo / elipse', polygon: 'Polígono', star: 'Estrela',
  cross: 'Cruz', lshape: 'Forma em L', heart: 'Coração', santa: 'Pai Natal',
  bunny: 'Coelho', candycane: 'Bengala doce', pumpkin: 'Abóbora', ghost: 'Fantasma',
  text: 'Letra / número',
};

export const appFor = (spec) => (spec && APPS[spec.app]) || null;

/** The order backend, when one is running. `?api=` points at it. */
export const API_BASE = (new URLSearchParams(location.search).get('api') || '').replace(/\/+$/, '');

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
    if (!msg || !this.app || !this.app.ready.includes(msg.type)) return;
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
      const raw = await requestDesign(this.frame, this.app);
      if (!raw) throw new Error('Desenhe a peça antes de continuar.');
      // Each app reports its design in its own terms; `read` is where that
      // becomes the one shape the cart and the order backend both take.
      const design = this.app.read(raw, this.spec);
      design.id = await saveDesign(this.app, design);
      this.onDone(design);
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
function requestDesign(frame, app) {
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
      if (!msg || msg.type !== app.reply || msg.requestId !== requestId) return;
      cleanup();
      resolve(msg.design);
    }
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    }

    window.addEventListener('message', onMessage);
    target.postMessage({ type: app.ask, requestId }, '*');
  });
}

/**
 * Hand the design to the order backend if one is running.
 *
 * With `?api=` unset — the usual way to try this storefront — the design stays
 * in the browser and the cart carries the thumbnail alone. That is enough to
 * walk the whole purchase, and it is honest about what it is: nothing was
 * filed anywhere, so nothing can be printed.
 *
 * The two products have two backends (`shopify/` and `lego/server/`), so the
 * origin belongs to the app rather than to the store. One `?api=` is enough to
 * try either; a real deployment would carry both.
 */
async function saveDesign(app, design) {
  if (!API_BASE) return null;
  const res = await fetch(`${API_BASE}/api/designs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...design.payload, previewPng: design.previewPng }),
  });
  if (!res.ok) throw new Error(`O serviço de desenhos recusou (${res.status}).`);
  const data = await res.json();
  if (!data || !data.id) throw new Error('O serviço de desenhos não devolveu um id.');
  return data.id;
}

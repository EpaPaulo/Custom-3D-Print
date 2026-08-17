/**
 * Storefront bridge — drop this into the Shopify theme alongside the
 * configurator (theme app extension, or a plain <script type="module">).
 *
 * It carries the design from the browser to the order backend, then puts a
 * short reference on the cart line. The design itself never travels through
 * the cart: line item properties are small, customer-visible and awkward to
 * validate, so the cart holds an id and a thumbnail while the real record
 * lives server-side.
 *
 * The `_design_id` property is underscore-prefixed, which is Shopify's
 * convention for "keep this out of the customer-facing cart display". It still
 * appears on the order in the admin, which is where fulfilment reads it.
 */

const DESIGN_PROPERTY = '_design_id';

export class BridgeError extends Error {}

/**
 * @param {object}  opts
 * @param {string}  opts.apiBase    origin of the order backend, no trailing slash
 * @param {number|string} opts.variantId  Shopify variant to add
 * @param {number}  [opts.quantity]
 * @param {string}  [opts.previewLabel]  visible property name for the thumbnail
 * @returns {Promise<{designId: string, cartItem: object}>}
 */
export async function addPersonalisedToCart(opts) {
  const {
    apiBase,
    variantId,
    quantity = 1,
    previewLabel = 'Pré-visualização',
    frame = null,
    frameOrigin = '*',
  } = opts || {};

  if (!apiBase) throw new BridgeError('apiBase is required.');
  if (!variantId) throw new BridgeError('variantId is required.');

  const api = String(apiBase).replace(/\/+$/, '');
  const design = frame
    ? await readDesignFromFrame(frame, frameOrigin)
    : readDesign();
  assertOrderable(design);

  const created = await postJson(`${api}/api/designs`, {
    config: design.config,
    maskPng: design.maskPng,
    previewPng: design.previewPng,
  });

  if (!created || !created.id) {
    throw new BridgeError('The design service did not return an id.');
  }

  const properties = { [DESIGN_PROPERTY]: created.id };
  if (created.previewUrl) properties[previewLabel] = api + created.previewUrl;

  const cartItem = await postJson('/cart/add.js', {
    items: [{ id: variantId, quantity, properties }],
  });

  return { designId: created.id, cartItem };
}

function readDesign() {
  const api = window.BimbyCover;
  if (!api || typeof api.getDesign !== 'function') {
    throw new BridgeError('The configurator is not loaded on this page.');
  }
  return api.getDesign();
}

// The configurator usually sits in an iframe, so ask it across the boundary.
function readDesignFromFrame(frame, origin) {
  const target = frame.contentWindow;
  if (!target) throw new BridgeError('The configurator frame is not ready yet.');

  return new Promise((resolve, reject) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
      cleanup();
      reject(new BridgeError('The configurator did not respond.'));
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
    target.postMessage({ type: 'bimby:getDesign', requestId }, origin);
  });
}

function assertOrderable(design) {
  if (!design) {
    throw new BridgeError('Adicione texto ou uma imagem antes de comprar.');
  }
  if (design.config.mode !== 'template') {
    // Custom sizes are a design tool, not a product: the shop prints one cover.
    throw new BridgeError('Só a capa TM7 padrão pode ser encomendada.');
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }

  if (!res.ok) {
    const detail = (data && (data.error || data.description)) || text.slice(0, 200);
    throw new BridgeError(`${url} failed (${res.status}): ${detail}`);
  }
  return data;
}

// Convenience for themes that would rather not write any JavaScript: put
// data-cover-add and data-variant-id on a button and this wires itself up.
export function autoWire(apiBase, options = {}) {
  const { frameSelector = '[data-cover-frame]', onAdded = null } = options;

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-cover-add]');
    if (!btn) return;
    event.preventDefault();

    const errorEl = document.querySelector('[data-cover-error]');
    if (errorEl) errorEl.textContent = '';

    const previous = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'A adicionar…';
    try {
      const result = await addPersonalisedToCart({
        apiBase,
        variantId: btn.dataset.variantId,
        quantity: Number(btn.dataset.quantity || 1),
        frame: document.querySelector(frameSelector),
      });
      if (onAdded) onAdded(result);
      else window.location.href = '/cart';
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
      else alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = previous;
    }
  });
}

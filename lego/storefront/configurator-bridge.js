/**
 * Storefront bridge — drop this into the Shopify theme alongside the plate
 * configurator (theme app extension, or a plain <script type="module">).
 *
 * It carries the design from the browser to the order backend, then puts a
 * short reference on the cart line. The design itself never travels through
 * the cart: line item properties are small, customer-visible and awkward to
 * validate, so the cart holds an id and a thumbnail while the real record
 * lives server-side.
 *
 * A plate's whole design is a couple of dozen numbers, so unlike a stamped
 * cover there is no bitmap to move — but the same rule applies to where it is
 * kept, because the cart is not a place to validate dimensions.
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
 * @param {string}  [opts.zone]      destination to price shipping against
 * @param {HTMLIFrameElement} [opts.frame]  the configurator, if it is embedded
 * @param {string}  [opts.frameOrigin]   origin to address the frame at
 * @returns {Promise<{designId: string, quote: object, cartItem: object}>}
 */
export async function addPlateToCart(opts) {
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

  if (!design || !design.spec) {
    throw new BridgeError('There is no plate to order yet.');
  }

  const created = await postJson(`${api}/api/designs`, {
    spec: design.spec,
    previewPng: design.previewPng,
    zone: opts.zone,
  });

  if (!created || !created.id) {
    throw new BridgeError('The design service did not return an id.');
  }

  const properties = { [DESIGN_PROPERTY]: created.id };
  if (created.previewUrl) properties[previewLabel] = api + created.previewUrl;

  const cartItem = await postJson('/cart/add.js', {
    items: [{ id: variantId, quantity, properties }],
  });

  return { designId: created.id, quote: created.quote, cartItem };
}

/**
 * What the backend would charge for the plate currently on screen, without
 * keeping anything. Use it to show a live price beside the configurator.
 *
 * `zone` prices one destination; the answer carries every other destination
 * priced alongside it, so a shipping picker needs one request, not one per
 * option.
 */
export async function quotePlate(apiBase, spec, zone) {
  const api = String(apiBase).replace(/\/+$/, '');
  return postJson(`${api}/api/plates`, zone ? { ...spec, zone } : spec);
}

function readDesign() {
  const api = window.LegoPlate;
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
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new BridgeError('The configurator did not answer.'));
    }, 10000);

    function onMessage(event) {
      const msg = event.data;
      if (!msg || msg.type !== 'plate:design' || msg.requestId !== requestId) return;
      if (event.source !== target) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(msg.design);
    }

    window.addEventListener('message', onMessage);
    target.postMessage({ type: 'plate:getDesign', requestId }, origin);
  });
}

/**
 * What a whole cart costs, delivered.
 *
 * `items` are `{ designId, quantity }` or `{ spec, quantity }` — a cart holds
 * the first kind. Call this rather than quoting each line and adding it up:
 * the plates travel in one box, and one box is one delivery charge.
 *
 * The answer carries every destination priced for that same box, so a shipping
 * picker on the cart page needs one request.
 */
export async function quoteBasket(apiBase, items, zone) {
  const api = String(apiBase).replace(/\/+$/, '');
  if (!Array.isArray(items) || !items.length) {
    throw new BridgeError('There is nothing in the basket.');
  }
  return postJson(`${api}/api/baskets`, zone ? { items, zone } : { items });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new BridgeError(detail?.error || `${url} answered ${res.status}.`);
  }
  return res.json();
}

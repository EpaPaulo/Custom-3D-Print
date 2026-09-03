/**
 * The cart.
 *
 * A frontend-only cart, kept in localStorage, because this storefront exists to
 * test the buying experience rather than to take money: no Shopify, no backend
 * required, and a refresh does not lose what you were doing. When this becomes
 * a real theme, `cart` is the seam — every page goes through these five
 * methods, and Shopify's /cart/*.js answers all of them.
 *
 * A personalised line carries the design with it: an id when the order backend
 * is running, and always a small preview thumbnail, so the cart can show what
 * was actually designed rather than a stock picture of the part.
 */

const KEY = 'formcat-cart-v1';

/** localStorage is per-origin and small; a design thumbnail is capped to fit. */
const MAX_ITEMS = 40;

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((l) => l && l.handle) : [];
  } catch {
    return [];
  }
}

function write(lines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines.slice(0, MAX_ITEMS)));
  } catch {
    // A full quota should not lose the cart already on screen, so the write is
    // allowed to fail quietly — the page keeps working off the in-memory copy.
  }
  window.dispatchEvent(new CustomEvent('cart:change'));
}

/**
 * Two lines merge only when they are the same product, the same variant *and*
 * neither is personalised: two personalised covers are two different objects
 * even when every other field matches.
 */
const mergeable = (a, b) => a.handle === b.handle && a.colour === b.colour && !a.design && !b.design;

export const cart = {
  lines: read,

  count() {
    return read().reduce((n, l) => n + l.qty, 0);
  },

  subtotal() {
    return read().reduce((n, l) => n + l.price * l.qty, 0);
  },

  /**
   * @param {object} line
   * @param {string} line.handle
   * @param {string} line.title
   * @param {number} line.price     cents
   * @param {string} line.colour    variant label
   * @param {string} [line.variantId]
   * @param {number} [line.qty]
   * @param {object} [line.design]  { id, thumb, model, summary } when personalised
   */
  add(line) {
    const lines = read();
    const item = {
      id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      qty: 1,
      ...line,
    };
    const hit = lines.find((l) => mergeable(l, item));
    if (hit) hit.qty = Math.min(10, hit.qty + item.qty);
    else lines.push(item);
    write(lines);
    return item;
  },

  setQty(id, qty) {
    const lines = read();
    const line = lines.find((l) => l.id === id);
    if (!line) return;
    line.qty = Math.max(1, Math.min(10, Number(qty) || 1));
    write(lines);
  },

  remove(id) {
    write(read().filter((l) => l.id !== id));
  },

  clear() {
    write([]);
  },
};

/**
 * Shrink a design preview to something a cart line can carry.
 *
 * The configurator's preview is a full-size canvas PNG — hundreds of kilobytes,
 * and localStorage has a handful of megabytes for the whole origin. The cart
 * only ever draws it at thumbnail size, so it is redrawn small and stored as
 * JPEG. The full-resolution preview stays with the order backend, which is
 * where fulfilment reads it from anyway.
 */
export function thumbnail(dataUrl, width = 320) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, width / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f1216';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

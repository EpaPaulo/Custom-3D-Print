import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Where the model files live. They ship with the storefront; see README if you
// split the two repos up.
const modelDir = process.env.MODEL_DIR || path.join(root, '..', 'assets', 'model');

/**
 * The models this backend can build, keyed by the same ids the configurator
 * stamps onto every design. **This list has to track MODELS in
 * assets/js/app.js**: an id the configurator sends and this one does not know
 * is refused at POST /api/designs.
 *
 * `slug` names the files an operator downloads, so it is worth keeping
 * recognisable on a printer's SD card.
 */
export const models = [
  {
    id: 'cover',
    label: 'Capa do ecrã TM7',
    slug: 'capa-tm7',
    // Kept because it predates the second model and points at this one.
    path: process.env.TEMPLATE_STL || path.join(modelDir, 'tm7-cover.stl'),
  },
  {
    id: 'base',
    label: 'Base TM7 — disco',
    slug: 'base-tm7',
    path: path.join(modelDir, 'tm7-base.stl'),
  },
];

export const defaultModelId = models[0].id;
export const modelById = (id) => models.find((m) => m.id === id);

export const config = {
  port: Number(process.env.PORT || 3000),

  dataDir: process.env.DATA_DIR || path.join(root, 'data'),

  models,
  modelDir,

  // Shopify's webhook signing secret. Without it, webhooks are refused rather
  // than trusted — an unsigned order is not an order.
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',

  // Bearer token guarding everything that can reach a print file.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Storefront origins allowed to create designs.
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  // Ceilings. A stamp mask is a bitmap, so it is cheap to bound precisely.
  maxUploadBytes: 8 * 1024 * 1024,
  // The honest mask is the largest usable area at the configurator's finest
  // contour setting: the base's Ø 202 mm at 10 px/mm is 4.1 megapixels, so a
  // 4 M ceiling would refuse a legitimate order. This leaves headroom for one
  // more model without letting a mask cost unbounded memory — the summed-area
  // table over it is eight bytes a pixel.
  maxMaskPixels: 6_000_000,
  maxPreviewBytes: 2 * 1024 * 1024,

  // How deep the second filament runs into the cover.
  colourMin: 0.2,
  colourMax: 4,
  cellMin: 0.35,
  cellMax: 1.5,
};

export function assertRuntimeConfig() {
  const missing = [];
  if (!config.adminToken) missing.push('ADMIN_TOKEN');
  if (!config.webhookSecret) missing.push('SHOPIFY_WEBHOOK_SECRET');
  if (missing.length) {
    throw new Error(
      `Refusing to start without ${missing.join(' and ')}. ` +
      'Copy .env.example and set them; see README.',
    );
  }
  if (process.env.TEMPLATE_MODEL) {
    throw new Error(
      'TEMPLATE_MODEL is gone: this backend builds every model in config.js, ' +
      'and each design says which one it is. Remove it from the environment.',
    );
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),

  dataDir: process.env.DATA_DIR || path.join(root, 'data'),

  // The template lives in the storefront repo; see README if you split them up.
  templatePath: process.env.TEMPLATE_STL ||
    path.join(root, '..', 'assets', 'model', 'tm7-cover.stl'),

  // Shopify's webhook signing secret. Without it, webhooks are refused rather
  // than trusted — an unsigned order is not an order.
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',

  // Bearer token guarding everything that can reach a print file.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Storefront origins allowed to create designs.
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  // Ceilings. A stamp mask is a bitmap, so it is cheap to bound precisely.
  maxUploadBytes: 8 * 1024 * 1024,
  maxMaskPixels: 4_000_000,
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
}

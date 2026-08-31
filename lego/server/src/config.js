import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 3100),

  dataDir: process.env.DATA_DIR || path.join(root, 'data'),

  // Shopify's webhook signing secret. Without it, webhooks are refused rather
  // than trusted — an unsigned order is not an order.
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',

  // Bearer token guarding everything that can reach a print file.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Storefront origins allowed to create designs.
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  // A plate is described by a couple of dozen numbers, so the request body is
  // tiny; the preview image a storefront may attach is the only thing with any
  // size to it.
  maxBodyBytes: 256 * 1024,
  maxPreviewBytes: 2 * 1024 * 1024,

  // What a plate costs to have printed.
  price: {
    base: num(process.env.PRICE_BASE, 4.5),
    perGram: num(process.env.PRICE_PER_GRAM, 0.06),
    perHour: num(process.env.PRICE_PER_HOUR, 1.2),
    currency: process.env.CURRENCY || 'EUR',
  },

  // Whether anyone may ask this server to build a plate STL. Off by default:
  // in a shop the file is the thing being sold.
  allowPublicSTL: process.env.ALLOW_PUBLIC_STL === '1',
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

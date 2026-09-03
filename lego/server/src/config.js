import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : fallback);

// Drop the keys nothing was set for, so they fall through to the profile's own
// value rather than overriding it with a null.
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

/**
 * A carrier's price list out of the environment, as JSON.
 *
 * Refused rather than patched up if it is malformed: a shipping table that
 * silently half-loaded would undercharge every order it touched, and finding
 * that out from the accounts is worse than not starting.
 */
function parseZones(raw) {
  if (!raw) return null;
  let zones;
  try {
    zones = JSON.parse(raw);
  } catch {
    throw new Error('SHIPPING_ZONES is not valid JSON.');
  }
  if (!Array.isArray(zones) || !zones.length) {
    throw new Error('SHIPPING_ZONES must be a non-empty array of zones.');
  }
  for (const zone of zones) {
    if (!zone || typeof zone.id !== 'string' || !zone.id) {
      throw new Error('Every shipping zone needs an id.');
    }
    if (zone.tiers != null && !Array.isArray(zone.tiers)) {
      throw new Error(`Shipping zone "${zone.id}" has tiers that are not a list.`);
    }
    for (const tier of zone.tiers || []) {
      if (!Number.isFinite(tier.upToKg) || !Number.isFinite(tier.price)) {
        throw new Error(`Shipping zone "${zone.id}" has a tier without upToKg and price.`);
      }
    }
  }
  return zones;
}

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

  // What a plate costs to have printed. Material and machine time come from
  // slicing the actual mesh, so these are rates rather than guesses.
  price: {
    base: num(process.env.PRICE_BASE, 4.5),
    perGram: num(process.env.PRICE_PER_GRAM, 0.06),
    perHour: num(process.env.PRICE_PER_HOUR, 1.2),
    currency: process.env.CURRENCY || 'EUR',
  },

  // Ceilings for a basket. Every distinct plate in one has to be built and
  // sliced before it can be priced, which is the expensive part — identical
  // ones are only done once, so it is the number of *different* plates that is
  // bounded tightly, not how many were ordered.
  basket: {
    maxLines: num(process.env.BASKET_MAX_LINES, 20),
    maxQuantity: num(process.env.BASKET_MAX_QUANTITY, 100),
    maxUnits: num(process.env.BASKET_MAX_UNITS, 250),
  },

  // Where this shop sends things, and what the box adds. SHIPPING_ZONES
  // replaces the built-in price list wholesale; the scalars beside it tune the
  // parcel the plate goes in. SHIPPING_FLAT overrides the lot with one number
  // for a shop that charges the same to send anything.
  shipping: {
    enabled: process.env.SHIPPING_ENABLED !== '0',
    defaultZone: process.env.SHIPPING_DEFAULT_ZONE || 'pt',
    freeAbove: num(process.env.SHIPPING_FREE_ABOVE, 0),
    flat: num(process.env.SHIPPING_FLAT, null),
    zones: parseZones(process.env.SHIPPING_ZONES),
    parcel: defined({
      packagingGrams: num(process.env.PACKAGING_GRAMS, null),
      paddingMm: num(process.env.PARCEL_PADDING_MM, null),
      minHeightMm: num(process.env.PARCEL_MIN_HEIGHT_MM, null),
      volumetricDivisor: num(process.env.VOLUMETRIC_DIVISOR, null),
    }),
  },

  // How this shop prints. A preset, plus the handful of settings a shop
  // actually changes; anything left unset keeps the preset's value. These
  // decide the quote, so they should match the profile the shop really uses.
  print: {
    profile: process.env.PRINT_PROFILE || 'normal',
    overrides: defined({
      layerHeight: num(process.env.LAYER_HEIGHT, null),
      walls: num(process.env.WALLS, null),
      topLayers: num(process.env.TOP_LAYERS, null),
      bottomLayers: num(process.env.BOTTOM_LAYERS, null),
      infill: num(process.env.INFILL, null),
    }),
    machine: defined({
      lineWidth: num(process.env.LINE_WIDTH, null),
      filamentDiameter: num(process.env.FILAMENT_DIAMETER, null),
      density: num(process.env.FILAMENT_DENSITY, null),
      speedFactor: num(process.env.SPEED_FACTOR, null),
    }),
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

// Server-side plate generation.
//
// The browser sends the *spec* — a shape and a few dozen millimetres — never a
// finished mesh. The geometry is then built here, by the same module the
// configurator previews with, so what goes on the printer is what the customer
// approved, and a customer can never hand this server arbitrary triangles to
// put on a machine.
//
// Sharing that module rather than reimplementing it is the point: a plate that
// previewed at 226 mm and printed at 224 would be a refund, and the only way to
// be sure the two agree is for there to be one of them.

import {
  buildPlate, normaliseSpec, resolve, SpecError,
  SHAPES, SYSTEMS, PATTERNS, QUALITIES, DEFAULTS, LIMITS, FONTS, CHARACTERS,
} from '../../assets/js/plate.js';
import { slicePrint, PROFILES } from '../../assets/js/slice.js';
import { priceOf, shippingOptions, ZONES } from '../../assets/js/price.js';
import { trianglesToSTL } from '../../assets/js/stl.js';
import { config } from './config.js';

export { SpecError, normaliseSpec };

/**
 * Everything a storefront needs to present the generator without hardcoding
 * dimensions only this side knows.
 */
export function catalogue() {
  return {
    shapes: SHAPES,
    systems: SYSTEMS,
    patterns: PATTERNS,
    qualities: Object.entries(QUALITIES).map(([id, q]) => ({ id, label: q.label })),
    // Names only. The glyph outlines behind them are tens of kilobytes and are
    // of no use to a storefront, which sends a character and gets a plate.
    fonts: FONTS.map((f) => ({ id: f.id, label: f.label })),
    profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label })),
    shipping: config.shipping.enabled ? {
      defaultZone: config.shipping.defaultZone,
      freeAbove: config.shipping.freeAbove,
      zones: (config.shipping.zones || ZONES).map((z) => ({ id: z.id, label: z.label })),
    } : null,
    characters: CHARACTERS,
    defaults: DEFAULTS,
    limits: LIMITS,
    currency: config.price.currency,
  };
}

/**
 * What a plate costs, from slicing it.
 *
 * The shape of a plate is not something a formula can price. A thin baseplate
 * is nearly all skin and prints at close to its solid weight; a 6 mm one is
 * mostly air and comes out at a third of it. Pricing either from the mesh's
 * volume overcharges someone — which is the whole reason this goes through a
 * slicer instead.
 *
 * The profile is the shop's, out of the environment, so the quote is for the
 * way this shop actually prints rather than for a generic one.
 */
export function quote(plate, zone) {
  const print = slicePrint(plate.positions, {
    profile: config.print.profile,
    overrides: config.print.overrides,
    machine: config.print.machine,
  });

  const shipping = {
    enabled: config.shipping.enabled,
    zone: zone || config.shipping.defaultZone,
    zones: config.shipping.zones || undefined,
    parcel: config.shipping.parcel,
    freeAbove: config.shipping.freeAbove,
    ...(config.shipping.flat != null ? { flat: config.shipping.flat } : {}),
  };

  const priced = priceOf(print, { rates: config.price, shipping });

  // Every destination priced alongside, so a storefront can offer the choice
  // without asking again for each one.
  return config.shipping.enabled && config.shipping.flat == null
    ? { ...priced, shippingOptions: shippingOptions(print, { rates: config.price, shipping }) }
    : priced;
}

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Validate a spec and say what it comes to, without keeping anything.
 *
 * The geometry is built rather than estimated: stud count and triangle count
 * are properties of the mesh, and a plate whose studs will not fit its own
 * shape should say so here, not once someone has paid.
 */
export function describe(input, zone) {
  const spec = normaliseSpec(input);
  const plate = buildPlate(spec);
  const d = resolve(spec);

  return {
    spec,
    size: {
      x: round(plate.size.x, 3),
      y: round(plate.size.y, 3),
      z: round(plate.size.z, 3),
    },
    grid: { x: spec.width, y: spec.depth, pitch: round(d.pitch, 4) },
    studs: plate.studs.length,
    triangles: plate.triangles,
    stlBytes: 84 + plate.triangles * 50,
    // The solid volume of the mesh. Kept because it is a property of the
    // geometry, unlike the quote, which is a property of how it gets printed.
    volumeMm3: round(plate.volume, 1),
    quote: quote(plate, zone),
  };
}

/** The print file for a spec, as a Buffer of binary STL. */
export function renderSTL(input, name = 'plate') {
  const spec = normaliseSpec(input);
  const plate = buildPlate(spec);
  const { buffer } = trianglesToSTL(plate.positions, `${name} ${spec.width}x${spec.depth} ${spec.shape}`);
  return Buffer.from(buffer);
}

/** A filename an operator can recognise on a printer's SD card. */
export function slug(spec) {
  const clean = (v, fallback) => String(v == null || v === '' ? fallback : v).replace(/[^a-z0-9]/gi, '');
  const what = spec.shape === 'text'
    ? `letra-${clean(spec.char, 'A')}-${clean(spec.font, 'sans')}`
    : clean(spec.shape, 'rect');
  return `placa-${what}-${spec.width}x${spec.depth}`;
}

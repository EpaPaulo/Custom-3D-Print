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
  buildPlate, normaliseSpec, resolve, estimate, SpecError,
  SHAPES, SYSTEMS, PATTERNS, QUALITIES, DEFAULTS, LIMITS, FONTS, CHARACTERS,
} from '../../assets/js/plate.js';
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
    characters: CHARACTERS,
    defaults: DEFAULTS,
    limits: LIMITS,
    currency: config.price.currency,
  };
}

/**
 * How long a plate takes to print, roughly.
 *
 * Rough is the honest word for it: a real answer comes from a slicer, with the
 * layer height, infill and speed the shop actually uses. This is a quote, built
 * from the two things that dominate a plate — the material to lay down, and the
 * stud count, because each stud is a small perimeter the head has to slow into
 * and retract out of. It moves the right way when the plate grows, which is all
 * a quote needs to do.
 *
 * The rate is the effective one for a 0.4 mm nozzle at 0.2 mm layers, well
 * under what a hotend can push, because acceleration is what actually limits a
 * surface covered in 5 mm circles.
 */
export function printHours(plate) {
  const minutes = plate.volume / 240 + plate.studs.length * 0.12;
  return minutes / 60;
}

export function quote(plate) {
  const f = estimate(plate.volume);
  const hours = printHours(plate);
  const total = config.price.base + f.grams * config.price.perGram + hours * config.price.perHour;
  return {
    currency: config.price.currency,
    grams: round(f.grams, 1),
    metres: round(f.metres, 2),
    hours: round(hours, 2),
    total: round(total, 2),
  };
}

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Validate a spec and say what it comes to, without keeping anything.
 *
 * The geometry is built rather than estimated: stud count and triangle count
 * are properties of the mesh, and a plate whose studs will not fit its own
 * shape should say so here, not once someone has paid.
 */
export function describe(input) {
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
    volumeMm3: round(plate.volume, 1),
    quote: quote(plate),
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

// End-to-end smoke test. Runs the real app against a temp data directory:
// no mocks, no stubbed storage, and the STL that comes out is parsed back and
// checked for the property that actually matters — that it is a closed solid.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WEBHOOK_SECRET = 'test-webhook-secret';
const ADMIN_TOKEN = 'test-admin-token';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'plateshop-'));
process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.ALLOWED_ORIGINS = 'https://shop.example.com';

const { createApp } = await import('../src/server.js');
const store = await import('../src/store.js');
const { buildPlate, normaliseSpec, resolve, SpecError, SHAPES, FONTS, CHARACTERS, MIN_THICKNESS } = await import('../../assets/js/plate.js');
const { earcut, deviation } = await import('../../assets/js/earcut.js');
const { slicePrint, PROFILES } = await import('../../assets/js/slice.js');
const { priceOf, priceBasket, shippingFor, parcelFor, packParcel, shippingOptions, ZONES } = await import('../../assets/js/price.js');

await store.init();

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    results.push(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const json = (p, opts = {}) => fetch(base + p, opts).then(async (r) => ({
  status: r.status, body: await r.json().catch(() => null), raw: r,
}));

const post = (p, body, headers = {}) => json(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };

// A 1x1 PNG, enough to prove the preview path stores and serves bytes.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A 28 x 25 plate — the size of the baseplate this project started from.
const REFERENCE = { shape: 'rect', width: 28, depth: 25 };

// LEGO's own lattice. A plate shares it with every real brick, so these are
// facts to hold the generator to rather than settings.
const LEGO = { pitch: 8, clearance: 0.2, studDiameter: 4.8, studHeight: 1.8 };

// --- geometry --------------------------------------------------------------

/**
 * Whether a triangle soup is a closed surface: every directed edge must have
 * exactly one opposite. This is the property a slicer depends on, and the one
 * that quietly breaks when the geometry changes, so it is checked here rather
 * than left to whoever loads the file.
 */
function surfaceFaults(positions) {
  const key = (i) => `${positions[i].toFixed(4)},${positions[i + 1].toFixed(4)},${positions[i + 2].toFixed(4)}`;
  const seen = new Map();
  for (let i = 0; i < positions.length; i += 9) {
    const v = [key(i), key(i + 3), key(i + 6)];
    for (let k = 0; k < 3; k++) {
      const e = `${v[k]}|${v[(k + 1) % 3]}`;
      seen.set(e, (seen.get(e) || 0) + 1);
    }
  }
  let faults = 0;
  for (const [edge, count] of seen) {
    const [a, b] = edge.split('|');
    if (count !== 1 || seen.get(`${b}|${a}`) !== 1) faults++;
  }
  return faults;
}

function stlBounds(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const n = view.getUint32(80, true);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      for (let a = 0; a < 3; a++) {
        const v = view.getFloat32(84 + t * 50 + 12 + k * 12 + a * 4, true);
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
  }
  return { triangles: n, size: hi.map((v, a) => v - lo[a]) };
}

await check('every shape builds a closed solid with positive volume', () => {
  for (const shape of SHAPES) {
    const plate = buildPlate({ shape: shape.id, width: 18, depth: 15, quality: 'normal' });
    assert.equal(surfaceFaults(plate.positions), 0, `${shape.id} is not closed`);
    assert.ok(plate.volume > 0, `${shape.id} is inside out`);
  }
});

await check('the triangulator covers a holed polygon exactly', () => {
  // A square with a square hole, then the shape the top face actually asks for:
  // an outline with many circular holes in it. Deviation is the fraction of the
  // polygon's area the triangles fail to cover, and it should be nothing.
  const holed = [0, 0, 40, 0, 40, 40, 0, 40, 16, 16, 16, 24, 24, 24, 24, 16];
  assert.ok(deviation(holed, [4], 2, earcut(holed, [4], 2, true)) < 1e-12);

  const coords = [0, 0, 80, 0, 80, 80, 0, 80];
  const holes = [];
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      holes.push(coords.length / 2);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        coords.push(6 + i * 10 + Math.cos(a) * 2.4, 6 + j * 10 + Math.sin(a) * 2.4);
      }
    }
  }
  assert.ok(deviation(coords, holes, 2, earcut(coords, holes, 2, true)) < 1e-9);
});

await check('stud patterns and hollow studs stay closed', () => {
  for (const pattern of ['full', 'border', 'checker', 'none']) {
    for (const hollowStuds of [false, true]) {
      const plate = buildPlate({ shape: 'ellipse', width: 12, depth: 12, pattern, hollowStuds });
      assert.equal(surfaceFaults(plate.positions), 0, `${pattern}/${hollowStuds} is not closed`);
    }
  }
});

await check('every letter and number is a closed solid in every face', () => {
  // The letters are the only shapes with holes in them, so this is the check
  // that the counter of an O is a hole all the way through rather than a hole
  // in the top and a lid underneath.
  for (const font of FONTS) {
    for (const ch of CHARACTERS) {
      const plate = buildPlate({ shape: 'text', char: ch, font: font.id, depth: 14 });
      assert.equal(surfaceFaults(plate.positions), 0, `${font.id} "${ch}" is not closed`);
      assert.ok(plate.volume > 0, `${font.id} "${ch}" is inside out`);
      assert.ok(plate.studs.length > 0, `${font.id} "${ch}" has no studs`);
    }
  }
});

await check('the letters that need counters have them, and the rest do not', () => {
  const holes = (ch) => buildPlate({ shape: 'text', char: ch, depth: 14 }).rings.holes.length;
  assert.equal(holes('O'), 1);
  assert.equal(holes('B'), 2);
  assert.equal(holes('8'), 2);
  assert.equal(holes('L'), 0);
  assert.equal(holes('7'), 0);
  // A monospaced zero is drawn with a dot inside its counter. That dot is a
  // separate island of material, which a one-piece plate cannot carry, so it
  // is dropped rather than turned into a second hole.
  assert.equal(buildPlate({ shape: 'text', char: '0', font: 'mono', depth: 14 }).rings.holes.length, 1);
});

await check('a letter is sized from its own glyph, not from the width slider', () => {
  // Whatever width comes in is overruled: a letter squashed to someone else's
  // width is a different letter.
  const wide = buildPlate({ shape: 'text', char: 'I', depth: 20, width: 40 });
  const narrow = buildPlate({ shape: 'text', char: 'W', depth: 20, width: 2 });
  assert.ok(wide.spec.width < 10, `I came out ${wide.spec.width} studs wide`);
  assert.ok(narrow.spec.width > 20, `W came out ${narrow.spec.width} studs wide`);
  // ...and taller means proportionally wider, since the shape is fixed.
  const small = buildPlate({ shape: 'text', char: 'M', depth: 10 });
  const big = buildPlate({ shape: 'text', char: 'M', depth: 30 });
  assert.ok(big.spec.width > small.spec.width * 2.5, 'the letter did not scale with its height');
});

await check('lowercase is accepted, anything unprintable is refused', () => {
  assert.equal(normaliseSpec({ shape: 'text', char: 'q' }).char, 'Q');
  assert.throws(() => normaliseSpec({ shape: 'text', char: '%' }), SpecError);
  assert.throws(() => normaliseSpec({ shape: 'text', font: 'comic-sans' }), SpecError);
});

await check('a bed-sized plate stays closed at the finest contour', () => {
  const plate = buildPlate({ shape: 'rect', width: 32, depth: 32, quality: 'fine' });
  assert.equal(surfaceFaults(plate.positions), 0);
  assert.equal(plate.studs.length, 1024);
});

await check('the grid is LEGO\'s, to the micron, and nothing can move it', () => {
  // This is the check that matters, and the one whose absence let a plate ship
  // that no brick would sit on. The supplied reference mesh is a 1 % upscale —
  // 8.08 mm pitch, 4.899 mm studs — and matching it is exactly what must not
  // happen: 1 % is 0.24 mm across a 2x4 brick and 0.56 mm across a 1x8, and a
  // brick is rigid.
  const d = resolve(normaliseSpec({}));
  assert.equal(d.pitch, LEGO.pitch, `pitch ${d.pitch}`);
  assert.equal(d.clearance, LEGO.clearance);
  assert.equal(d.studHeight, LEGO.studHeight);

  const plate = buildPlate(REFERENCE);
  assert.equal(plate.studs.length, 700);
  // A 28-stud run is 28 pitches less the clearance, which is what a real
  // baseplate of that size measures.
  assert.ok(Math.abs(plate.size.x - (28 * 8 - 0.2)) < 1e-6, `width ${plate.size.x}`);
  assert.ok(Math.abs(plate.size.y - (25 * 8 - 0.2)) < 1e-6, `depth ${plate.size.y}`);

  // Stud centres land on the lattice a brick expects, all the way across.
  const xs = [...new Set(plate.studs.map((s) => Math.round(s.x * 1e6) / 1e6))].sort((a, b) => a - b);
  assert.equal(xs.length, 28);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(Math.abs((xs[i] - xs[i - 1]) - LEGO.pitch) < 1e-9, `gap ${xs[i] - xs[i - 1]}`);
  }
  assert.ok(Math.abs((xs[27] - xs[0]) - 27 * LEGO.pitch) < 1e-6, 'error accumulated across the plate');
});

await check('trimming the stud changes the stud and nothing else', () => {
  // The fit knob must not be a scale. Scaling the model to loosen a stud is
  // what put the grid 1 % out in the first place.
  const loose = buildPlate({ width: 12, depth: 12, studTrim: -0.3 });
  const tight = buildPlate({ width: 12, depth: 12, studTrim: 0.1 });

  assert.equal(loose.dims.pitch, tight.dims.pitch);
  assert.equal(loose.size.x, tight.size.x);
  assert.equal(loose.size.y, tight.size.y);
  assert.equal(loose.size.z, tight.size.z);
  assert.equal(loose.studs.length, tight.studs.length);
  assert.ok(loose.dims.radius < tight.dims.radius, 'the trim did not reach the stud');
  assert.ok(Math.abs((tight.dims.radius - loose.dims.radius) * 2 - 0.4) < 1e-9);

  // And the default takes something off, because FDM adds it back.
  assert.ok(resolve(normaliseSpec({})).radius * 2 < LEGO.studDiameter,
    'a stud modelled at nominal will print too fat to fit');
});

await check('hollow studs use less material than solid ones', () => {
  const solid = buildPlate({ width: 8, depth: 8 });
  const hollow = buildPlate({ width: 8, depth: 8, hollowStuds: true });
  assert.ok(hollow.volume < solid.volume, 'bore removed nothing');
});

await check('no stud is ever left hanging over the edge', () => {
  // A round plate is the case that catches this: on a rectangle every grid
  // position is inside by construction, so nothing would be exercised.
  const plate = buildPlate({ shape: 'ellipse', width: 20, depth: 20 });
  const radius = plate.size.x / 2;
  const need = plate.dims.radius + plate.dims.margin;
  for (const stud of plate.studs) {
    assert.ok(Math.hypot(stud.x, stud.y) + need <= radius + 1e-6,
      `stud at ${stud.x.toFixed(1)},${stud.y.toFixed(1)} runs off the plate`);
  }
  assert.ok(plate.studs.length > 250, `only ${plate.studs.length} studs kept`);
});

await check('the dimensions that decide compatibility cannot be overridden', () => {
  // Pitch, stud and clearance are what LEGO compatibility is. They come from
  // the system, and a caller sending its own — or a spec stored by an older
  // build that let them be edited — is ignored rather than obeyed.
  const forced = normaliseSpec({
    studHeight: 3.2, studDiameter: 6.75, pitch: 11.5, clearance: 0.9, studWall: 4,
  });
  assert.equal(forced.pitch, LEGO.pitch);
  assert.equal(forced.studDiameter, LEGO.studDiameter);
  assert.equal(forced.studHeight, LEGO.studHeight);
  assert.equal(forced.clearance, LEGO.clearance);

  // The system still decides them, so Duplo is Duplo.
  assert.equal(normaliseSpec({ system: 'duplo', pitch: 11.5 }).pitch, 16);

  // A plate built from a spec carrying junk is the standard one, to the micron.
  const plate = buildPlate({ width: 28, depth: 25, pitch: 11.5, studDiameter: 6.75 });
  assert.ok(Math.abs(plate.size.x - (28 * 8 - 0.2)) < 1e-6, `width ${plate.size.x}`);
  assert.equal(plate.studs.length, 700);

  // Thickness is the exception: a real choice, and still settable above the
  // floor. Below it, a plate stops being rigid enough to sell.
  assert.equal(normaliseSpec({ thickness: 6 }).thickness, 6);
  assert.equal(buildPlate({ width: 8, depth: 8, thickness: 6 }).size.z > 6, true);
  assert.equal(normaliseSpec({ thickness: 1.3 }).thickness, MIN_THICKNESS);
  assert.equal(normaliseSpec({ thickness: 0.1 }).thickness, MIN_THICKNESS);
  // Duplo's own slab is already thicker than the floor, so the floor leaves it
  // alone rather than flattening every system to the same number.
  assert.ok(normaliseSpec({ system: 'duplo' }).thickness > MIN_THICKNESS);
});

await check('out-of-range numbers are clamped, unknown names are refused', () => {
  const spec = normaliseSpec({ width: 9999, studTrim: -5, thickness: -3 });
  assert.equal(spec.width, 96);
  assert.equal(spec.studTrim, -0.4);
  assert.equal(spec.thickness, MIN_THICKNESS);
  assert.throws(() => normaliseSpec({ shape: 'dodecahedron' }), SpecError);
  assert.throws(() => normaliseSpec({ width: 96, depth: 96 }), SpecError);
});

// --- slicing ---------------------------------------------------------------

await check('the slicer agrees with the mesh about how much solid there is', () => {
  // The sliced cross-sections are a raster of the same geometry, so the volume
  // they add up to has to match the mesh's own. This is what says the layer
  // rasterisation is right; everything downstream of it is arithmetic.
  for (const spec of [{}, { shape: 'ellipse', width: 14, depth: 14 }, { shape: 'text', char: 'B', depth: 16 }]) {
    const plate = buildPlate(spec);
    const print = slicePrint(plate.positions);
    const off = Math.abs(print.solidMm3 - plate.volume) / plate.volume;
    assert.ok(off < 0.06, `sliced solid is ${(off * 100).toFixed(1)}% off the mesh volume`);
  }
});

await check('a print never takes more material than the same thing solid', () => {
  for (const profile of Object.keys(PROFILES)) {
    for (const spec of [{}, { width: 20, depth: 20, thickness: 6 }, { system: 'duplo', width: 6, depth: 6 }]) {
      const print = slicePrint(buildPlate(spec).positions, { profile });
      assert.ok(print.volumeMm3 <= print.solidMm3 * 1.001,
        `${profile} extrudes more than solid: ${print.volumeMm3} > ${print.solidMm3}`);
      assert.ok(print.grams > 0);
    }
  }
});

await check('a thick plate prints far lighter than its volume, a thin one does not', () => {
  // This is the whole reason for slicing. A thin baseplate is nearly all skin
  // and comes out near its solid weight; a thick one is mostly air, and pricing
  // it by volume would overcharge by a factor of two or more.
  const thin = slicePrint(buildPlate({ width: 20, depth: 20 }).positions);
  const thick = slicePrint(buildPlate({ width: 20, depth: 20, thickness: 6 }).positions);

  const fillOf = (p) => p.volumeMm3 / p.solidMm3;
  assert.ok(fillOf(thin) > 0.6, `thin plate only ${(fillOf(thin) * 100).toFixed(0)}% filled`);
  assert.ok(fillOf(thick) < 0.45, `thick plate ${(fillOf(thick) * 100).toFixed(0)}% filled`);
  assert.ok(fillOf(thin) > fillOf(thick) * 1.4, 'thickness barely changed how much is air');
  // And the thick one weighs nowhere near its volume ratio would suggest.
  assert.ok(thick.grams < thin.grams * 2.5, 'thick plate scaled like solid material');
});

await check('the settings move the estimate the way they should', () => {
  const positions = buildPlate({ width: 16, depth: 16, thickness: 5 }).positions;
  const at = (overrides) => slicePrint(positions, { overrides });

  assert.ok(at({ infill: 0.5 }).grams > at({ infill: 0.1 }).grams, 'infill did not add material');
  assert.ok(at({ walls: 5 }).grams > at({ walls: 1 }).grams, 'walls did not add material');
  assert.ok(at({ layerHeight: 0.12 }).hours > at({ layerHeight: 0.28 }).hours, 'thin layers were not slower');
  assert.ok(at({ topLayers: 8 }).grams > at({ topLayers: 1 }).grams, 'skin did not add material');
});

await check('a bigger plate costs more, and the base fee is always in there', () => {
  const at = (spec) => priceOf(slicePrint(buildPlate(spec).positions), { shipping: { enabled: false } });
  const small = at({ width: 8, depth: 8 });
  const large = at({ width: 24, depth: 24 });
  assert.ok(large.goods > small.goods * 2, 'price barely moved with size');
  assert.ok(small.goods > small.base, 'the base fee went missing');
  assert.equal(small.goods, Math.round((small.base + small.material + small.machine) * 100) / 100);
  assert.equal(small.shipping, null);
  assert.equal(small.total, small.goods);
});

// --- shipping --------------------------------------------------------------

await check('a plate is billed on the size of its box, not on what it weighs', () => {
  // The point of quoting shipping from the geometry: a baseplate is light and
  // the size of a sheet of paper, and a carrier charges for the second of
  // those. Getting this backwards under-quotes every large plate.
  const big = slicePrint(buildPlate({ width: 40, depth: 40 }).positions);
  const parcel = parcelFor(big.size, big.grams);
  assert.equal(parcel.billedBy, 'size', 'a 40-stud plate should bill on volume');
  assert.ok(parcel.volumetricKg > parcel.actualKg * 2, 'volumetric weight barely moved');
  assert.equal(parcel.billedKg, parcel.volumetricKg);

  // A small tile is the other way round: mostly packaging, and billed for it.
  const tile = slicePrint(buildPlate({ width: 6, depth: 6 }).positions);
  assert.equal(parcelFor(tile.size, tile.grams).billedBy, 'weight');
});

await check('shipping rises with distance and with the parcel', () => {
  const small = slicePrint(buildPlate({ width: 8, depth: 8 }).positions);
  const large = slicePrint(buildPlate({ width: 44, depth: 44 }).positions);

  assert.equal(shippingFor(small.size, small.grams, { zone: 'pickup' }).price, 0);
  const home = shippingFor(small.size, small.grams, { zone: 'pt' }).price;
  const abroad = shippingFor(small.size, small.grams, { zone: 'world' }).price;
  assert.ok(abroad > home, 'the world costs no more than next door');

  assert.ok(shippingFor(large.size, large.grams, { zone: 'pt' }).price > home,
    'a much larger parcel ships for the same price');

  // An unknown destination falls back to the default rather than shipping free.
  assert.ok(shippingFor(small.size, small.grams, { zone: 'mars' }).price > 0);
});

await check('a parcel past the last bracket is quoted, not refused', () => {
  const heavy = { grams: 40000, size: { x: 400, y: 400, z: 200 }, hours: 1, metres: 1, layers: 1, volumeMm3: 1, solidMm3: 1, profile: {} };
  const quoted = shippingFor(heavy.size, heavy.grams, { zone: 'pt' });
  const top = ZONES.find((z) => z.id === 'pt').tiers.slice(-1)[0];
  assert.ok(quoted.parcel.billedKg > top.upToKg, 'the fixture is not actually oversized');
  assert.ok(quoted.price > top.price, 'the per-kilo rate never kicked in');
});

await check('free shipping applies above a threshold, and a flat rate overrides the table', () => {
  const print = slicePrint(buildPlate({ width: 20, depth: 20 }).positions);

  const under = priceOf(print, { shipping: { zone: 'pt', freeAbove: 1000 } });
  assert.ok(under.shipping.price > 0);
  assert.equal(under.shipping.free, false);

  const over = priceOf(print, { shipping: { zone: 'pt', freeAbove: 1 } });
  assert.equal(over.shipping.price, 0);
  assert.equal(over.shipping.free, true);
  assert.equal(over.total, over.goods);

  const flat = priceOf(print, { shipping: { flat: 4.25 } });
  assert.equal(flat.shipping.price, 4.25);
  assert.equal(flat.total, Math.round((flat.goods + 4.25) * 100) / 100);
});

await check('several plates share one box, and the box is packed not stacked', () => {
  const big = slicePrint(buildPlate({}).positions);
  const tile = slicePrint(buildPlate({ width: 8, depth: 8 }).positions);

  // Three tiles fit beside nothing, but they fit beside each other: the box is
  // the big plate's footprint, two layers deep rather than four.
  const parcel = packParcel([
    { size: big.size, grams: big.grams },
    ...Array.from({ length: 3 }, () => ({ size: tile.size, grams: tile.grams })),
  ]);
  assert.equal(parcel.items, 4);
  assert.equal(parcel.layers, 2, `packed into ${parcel.layers} layers`);
  assert.ok(parcel.lengthMm <= big.size.x + 30, 'the box grew beyond the largest plate');

  // And identical plates stack into as few layers as their areas allow.
  const stacked = packParcel(Array.from({ length: 4 }, () => ({ size: big.size, grams: big.grams })));
  assert.equal(stacked.layers, 4, 'four full-size plates cannot share a layer');
  assert.ok(stacked.heightMm > parcel.heightMm);
});

await check('a basket costs less to ship than the same plates quoted one by one', () => {
  const big = slicePrint(buildPlate({}).positions);
  const tile = slicePrint(buildPlate({ width: 8, depth: 8 }).positions);

  const basket = priceBasket(
    [{ print: big, quantity: 1, spec: {} }, { print: tile, quantity: 3, spec: {} }],
    { shipping: { zone: 'pt' } },
  );

  const apart = shippingFor(big.size, big.grams, { zone: 'pt' }).price
    + 3 * shippingFor(tile.size, tile.grams, { zone: 'pt' }).price;

  assert.ok(basket.shipping.price < apart, 'one box cost as much as four');
  assert.equal(basket.units, 4);
  assert.equal(basket.items.length, 2);
  assert.equal(basket.items[1].quantity, 3);
  // The base fee is per plate — each is its own print — and only the delivery
  // is shared. The arithmetic has to be one a customer can redo by hand: unit
  // price times quantity, lines adding to the goods, goods plus delivery.
  assert.equal(basket.items[1].lineTotal, Math.round(basket.items[1].unit.total * 3 * 100) / 100);
  assert.equal(basket.goods, Math.round(basket.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100);
  assert.equal(basket.total, Math.round((basket.goods + basket.shipping.price) * 100) / 100);
});

await check('every destination is priced at once for a storefront to offer', () => {
  const print = slicePrint(buildPlate({ width: 16, depth: 16 }).positions);
  const options = shippingOptions(print);
  assert.equal(options.length, ZONES.length);
  assert.ok(options.every((o) => o.price >= 0 && o.parcel.billedKg > 0));
  assert.equal(options.find((o) => o.zone === 'pickup').price, 0);
});

// --- API -------------------------------------------------------------------

await check('GET /api/health', async () => {
  const { status, body } = await json('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

await check('GET /api/catalogue lists what the server will build', async () => {
  const { status, body } = await json('/api/catalogue');
  assert.equal(status, 200);
  assert.ok(body.shapes.some((s) => s.id === 'heart'));
  assert.ok(body.systems.some((s) => s.id === 'lego'));
  assert.ok(body.limits.maxStuds > 0);
  assert.ok(body.fonts.some((f) => f.id === 'sans'));
  assert.equal(body.characters.length, 36);
  // Names, not outlines: the glyph data is tens of kilobytes and no use here.
  assert.equal(JSON.stringify(body.fonts).includes('glyphs'), false);
  assert.ok(JSON.stringify(body).length < 20000, 'the catalogue got fat');
});

await check('POST /api/plates builds a letter and names the file after it', async () => {
  const { status, body } = await post('/api/plates', { shape: 'text', char: 'r', font: 'serif', depth: 16 });
  assert.equal(status, 200);
  assert.equal(body.spec.char, 'R');
  assert.ok(body.studs > 0);

  const res = await fetch(base + '/api/plates/stl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ shape: 'text', char: 'R', font: 'serif', depth: 16 }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /placa-letra-R-serif/);
});

await check('POST /api/plates refuses a character it has no glyph for', async () => {
  const { status, body } = await post('/api/plates', { shape: 'text', char: 'ß' });
  assert.equal(status, 400);
  assert.match(body.error, /A-Z or 0-9/);
});

await check('POST /api/plates quotes the reference plate from a real slice', async () => {
  const { status, body } = await post('/api/plates', REFERENCE);
  assert.equal(status, 200);
  assert.equal(body.studs, 700);
  assert.equal(body.size.x, 223.8);
  assert.ok(body.quote.total > 0, 'no price');
  assert.ok(body.quote.grams > 50 && body.quote.grams < 110, `${body.quote.grams} g looks wrong`);
  assert.ok(body.quote.hours > 1, `${body.quote.hours} h looks wrong`);
  assert.ok(body.quote.layers > 5, 'no layer count');
  assert.ok(body.quote.fill > 0 && body.quote.fill <= 100, `fill ${body.quote.fill}%`);
  // Priced from the print, not from the solid: the mesh volume is heavier.
  assert.ok(body.quote.grams < (body.volumeMm3 / 1000) * 1.24, 'quoted the solid weight');

  // Delivered price: the goods plus getting them there.
  assert.ok(body.quote.goods > 0);
  assert.ok(body.quote.shipping.price > 0, 'nothing charged for shipping');
  assert.equal(body.quote.total, Math.round((body.quote.goods + body.quote.shipping.price) * 100) / 100);
  assert.ok(body.quote.shippingOptions.length > 1, 'no choice of destination offered');
});

await check('POST /api/plates prices the destination it was asked about', async () => {
  const home = await post('/api/plates', { ...REFERENCE, zone: 'pt' });
  const abroad = await post('/api/plates', { ...REFERENCE, zone: 'world' });
  const collected = await post('/api/plates', { ...REFERENCE, zone: 'pickup' });

  assert.ok(abroad.body.quote.total > home.body.quote.total, 'distance cost nothing');
  assert.equal(collected.body.quote.shipping.price, 0);
  assert.equal(collected.body.quote.total, collected.body.quote.goods);
  // Where it ships to says nothing about what it is, so the plate is identical.
  assert.equal(home.body.quote.grams, abroad.body.quote.grams);
  assert.deepEqual(home.body.spec, abroad.body.spec);
});

await check('GET /api/catalogue offers the destinations without the price list', async () => {
  const { body } = await json('/api/catalogue');
  assert.ok(body.shipping.zones.some((z) => z.id === 'pickup'));
  assert.equal(body.shipping.defaultZone, 'pt');
  // Names only: a storefront asks for a price, it does not compute one.
  assert.equal(JSON.stringify(body.shipping).includes('upToKg'), false);
});

await check('POST /api/plates refuses a shape it cannot build', async () => {
  const { status, body } = await post('/api/plates', { shape: 'blob' });
  assert.equal(status, 400);
  assert.match(body.error, /Unknown shape/);
});

await check('POST /api/plates/stl is closed to the public by default', async () => {
  const { status } = await post('/api/plates/stl', REFERENCE);
  assert.equal(status, 403);
});

await check('POST /api/plates/stl serves a solid to an admin', async () => {
  const res = await fetch(base + '/api/plates/stl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminHeaders },
    body: JSON.stringify(REFERENCE),
  });
  assert.equal(res.status, 200);
  const { triangles, size } = stlBounds(Buffer.from(await res.arrayBuffer()));
  assert.ok(triangles > 1000, `only ${triangles} triangles`);
  assert.ok(Math.abs(size[0] - (28 * 8 - 0.2)) < 0.01, `width ${size[0]}`);
  assert.ok(Math.abs(size[2] - (MIN_THICKNESS + LEGO.studHeight)) < 0.01, `height ${size[2]}`);
});

await check('POST /api/baskets prices a whole order in one box', async () => {
  const { status, body } = await post('/api/baskets', {
    zone: 'pt',
    items: [
      { spec: { shape: 'rect', width: 28, depth: 25 }, quantity: 1 },
      { spec: { shape: 'text', char: 'A', depth: 12 }, quantity: 2 },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.items.length, 2);
  assert.equal(body.units, 3);
  assert.equal(body.items[1].quantity, 2);
  assert.ok(body.parcel.items === 3 && body.parcel.layers >= 1);
  assert.equal(body.total, Math.round((body.goods + body.shipping.price) * 100) / 100);
  assert.ok(body.shippingOptions.length > 1);

  // The same plates asked for one at a time pay for a delivery each.
  const separately = await Promise.all(body.items.map((item) => post('/api/plates',
    { ...item.spec, zone: 'pt' })));
  const apart = separately.reduce((sum, r, i) =>
    sum + r.body.quote.total * body.items[i].quantity, 0);
  assert.ok(body.total < apart, `basket ${body.total} is not cheaper than ${apart}`);
});

await check('POST /api/baskets takes designs a cart already holds', async () => {
  const created = await post('/api/designs', { spec: { shape: 'ellipse', width: 12, depth: 12 } });
  assert.equal(created.status, 201);

  const { status, body } = await post('/api/baskets', {
    items: [{ designId: created.body.id, quantity: 2 }],
  });
  assert.equal(status, 200);
  assert.equal(body.items[0].designId, created.body.id);
  assert.equal(body.items[0].spec.shape, 'ellipse');
  assert.equal(body.units, 2);
});

await check('POST /api/baskets refuses what it cannot price', async () => {
  assert.equal((await post('/api/baskets', {})).status, 400);
  assert.equal((await post('/api/baskets', { items: [] })).status, 400);
  assert.equal((await post('/api/baskets', { items: [{}] })).status, 400);
  assert.equal((await post('/api/baskets', { items: [{ designId: 'a'.repeat(20) }] })).status, 404);
  assert.equal((await post('/api/baskets', { items: [{ spec: { shape: 'blob' } }] })).status, 400);

  const huge = await post('/api/baskets', { items: [{ spec: {}, quantity: 100000 }] });
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /quantity|at most/);

  const many = await post('/api/baskets', {
    items: Array.from({ length: 40 }, () => ({ spec: {}, quantity: 1 })),
  });
  assert.equal(many.status, 400);
});

// --- designs and orders ----------------------------------------------------

let designId;

await check('POST /api/designs keeps a design and its preview', async () => {
  const { status, body } = await post('/api/designs', {
    spec: { ...REFERENCE, shape: 'ellipse', width: 16, depth: 16 },
    previewPng: `data:image/png;base64,${PNG_1PX}`,
    note: 'para o aniversário',
  });
  assert.equal(status, 201);
  assert.ok(store.isValidId(body.id), `bad id ${body.id}`);
  assert.ok(body.quote.total > 0);
  designId = body.id;

  const png = await fetch(`${base}/api/designs/${designId}/preview.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
});

await check('POST /api/designs refuses a spec it cannot build', async () => {
  const { status } = await post('/api/designs', { spec: { shape: 'blob' } });
  assert.equal(status, 400);
});

await check('GET /api/designs/:id returns the spec but never the mesh', async () => {
  const { status, body } = await json(`/api/designs/${designId}`);
  assert.equal(status, 200);
  assert.equal(body.spec.shape, 'ellipse');
  assert.ok(body.studs > 0);
  assert.equal(JSON.stringify(body).includes('positions'), false);
});

await check('an unsigned webhook is refused', async () => {
  const { status } = await post('/webhooks/shopify/orders-create', { id: 1 });
  assert.equal(status, 401);
});

await check('a signed webhook records the order', async () => {
  const payload = JSON.stringify({
    id: 550, order_number: 1042, created_at: new Date().toISOString(),
    email: 'cliente@example.com',
    customer: { first_name: 'Ana', last_name: 'Silva' },
    line_items: [
      { id: 1, title: 'Placa personalizada', quantity: 2, properties: [{ name: 'design', value: designId }] },
      { id: 2, title: 'Autocolante', quantity: 1, properties: [] },
    ],
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('base64');
  const res = await fetch(base + '/webhooks/shopify/orders-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature },
    body: payload,
  });
  assert.equal(res.status, 200);

  const order = await store.getOrder('550');
  assert.ok(order, 'order not stored');
  // The sticker has no design id, so it is not a plate and is left out.
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].designId, designId);
  assert.equal(order.items[0].spec.shape, 'ellipse');
  assert.equal(order.status, 'new');
});

await check('the admin API needs the token', async () => {
  assert.equal((await json('/api/admin/orders')).status, 401);
  assert.equal((await json('/api/admin/orders', { headers: { Authorization: 'Bearer wrong-token--' } })).status, 401);
  assert.equal((await json('/api/admin/orders', { headers: adminHeaders })).status, 200);
});

await check('an admin can list, download and progress an order', async () => {
  const list = await json('/api/admin/orders?status=new', { headers: adminHeaders });
  assert.equal(list.body.length, 1);

  const stl = await fetch(`${base}/api/admin/designs/${designId}/plate.stl`, { headers: adminHeaders });
  assert.equal(stl.status, 200);
  assert.match(stl.headers.get('content-disposition'), /placa-ellipse-16x16/);
  const buffer = Buffer.from(await stl.arrayBuffer());
  const { triangles } = stlBounds(buffer);
  assert.equal(buffer.length, 84 + triangles * 50, 'STL length disagrees with its own header');

  const moved = await post('/api/admin/orders/550/status', { status: 'printed' }, adminHeaders);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.status, 'printed');
  assert.equal((await json('/api/admin/orders?status=new', { headers: adminHeaders })).body.length, 0);
});

await check('an unknown status is refused', async () => {
  const { status } = await post('/api/admin/orders/550/status', { status: 'shipped-ish' }, adminHeaders);
  assert.equal(status, 400);
});

// ---------------------------------------------------------------------------

server.close();
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

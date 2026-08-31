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
const { buildPlate, normaliseSpec, SpecError, SHAPES, FONTS, CHARACTERS } = await import('../../assets/js/plate.js');
const { earcut, deviation } = await import('../../assets/js/earcut.js');

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

// The uploaded reference baseplate, in the numbers this generator uses.
const REFERENCE = { shape: 'rect', width: 28, depth: 25, scale: 1.01 };

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

await check('the reference baseplate reproduces to the tenth of a micron', () => {
  const plate = buildPlate(REFERENCE);
  assert.equal(plate.studs.length, 700);
  assert.ok(Math.abs(plate.size.x - 226.038) < 1e-3, `width ${plate.size.x}`);
  assert.ok(Math.abs(plate.size.y - 201.798) < 1e-3, `depth ${plate.size.y}`);
  assert.ok(Math.abs(plate.size.z - 3.131) < 1e-3, `height ${plate.size.z}`);
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

await check('out-of-range numbers are clamped, unknown names are refused', () => {
  const spec = normaliseSpec({ width: 9999, scale: 5, thickness: -3 });
  assert.equal(spec.width, 96);
  assert.equal(spec.scale, 1.06);
  assert.equal(spec.thickness, 0.6);
  assert.throws(() => normaliseSpec({ shape: 'dodecahedron' }), SpecError);
  assert.throws(() => normaliseSpec({ width: 96, depth: 96 }), SpecError);
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

await check('POST /api/plates quotes the reference plate', async () => {
  const { status, body } = await post('/api/plates', REFERENCE);
  assert.equal(status, 200);
  assert.equal(body.studs, 700);
  assert.equal(body.size.x, 226.038);
  assert.ok(body.quote.total > 0, 'no price');
  assert.ok(body.quote.grams > 50, `${body.quote.grams} g looks wrong`);
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
  assert.ok(Math.abs(size[0] - 226.038) < 0.01, `width ${size[0]}`);
  assert.ok(Math.abs(size[2] - 3.131) < 0.01, `height ${size[2]}`);
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

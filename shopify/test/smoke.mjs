// End-to-end smoke test. Runs the real app against a temp data directory:
// no mocks, no stubbed storage, and the STL that comes out is parsed back.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

const WEBHOOK_SECRET = 'test-webhook-secret';
const ADMIN_TOKEN = 'test-admin-token';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'covershop-'));
process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.ALLOWED_ORIGINS = 'https://shop.example.com';

const { createApp } = await import('../src/server.js');
const store = await import('../src/store.js');
const { templateInfo, modelsInfo, loadModel } = await import('../src/render.js');

await store.init();

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const results = [];
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

// --- fixtures --------------------------------------------------------------

const allModels = await modelsInfo();
const info = await templateInfo('cover');
const baseInfo = await templateInfo('base');

// A band of ink across the usable area. `spread` says how far it reaches: the
// default sits well inside, and 1 runs the full width, which is what a round
// face has to cut back.
function makeMaskPng(wmm, hmm, ppm = 5, spread = 0.25, band = [0.40, 0.60]) {
  const w = Math.round(wmm * ppm);
  const h = Math.round(hmm * ppm);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = x > w * spread && x < w * (1 - spread) &&
                 y > h * band[0] && y < h * band[1];
      const i = (y * w + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = on ? 255 : 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const maskB64 = makeMaskPng(info.usableWidth, info.usableHeight).toString('base64');
const previewB64 = makeMaskPng(40, 30).toString('base64');

// Wide and tall enough that its corners would sit 108.7 mm from the centre of
// a face whose disc stops at 101 — so nothing but the clip can keep it on.
const baseMaskB64 = makeMaskPng(
  baseInfo.usableWidth, baseInfo.usableHeight, 5, 0, [0.30, 0.70],
).toString('base64');

// Reads an STL body back into a bounding box and the triangle count.
function measureSTL(buf) {
  const count = buf.readUInt32LE(80);
  assert.equal(buf.length, 84 + count * 50, 'STL length must match its triangle count');
  const box = {
    count,
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    for (let i = 0; i < 3; i++) {
      const x = buf.readFloatLE(o + 12 + i * 12);
      const y = buf.readFloatLE(o + 16 + i * 12);
      const z = buf.readFloatLE(o + 20 + i * 12);
      box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
      box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
    }
  }
  return box;
}

// Approve an order carrying one design, and hand back its print file.
let orderSeq = 6000;
async function printFileFor(id) {
  const orderId = String(++orderSeq);
  const body = JSON.stringify({
    id: Number(orderId), order_number: orderSeq, created_at: new Date().toISOString(),
    line_items: [{
      title: 'Peça personalizada', quantity: 1,
      properties: [{ name: '_design_id', value: id }],
    }],
  });
  const hook = await json('/webhooks/shopify/orders-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': sign(body) },
    body,
  });
  assert.equal(hook.status, 200);
  await json(`/admin/orders/${orderId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  const res = await fetch(`${base}/admin/designs/${id}/model.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return { orderId, res };
}

const sign = (body) =>
  crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

// --- tests -----------------------------------------------------------------

for (const m of allModels) {
  const usable = m.round
    ? `usable \u00d8 ${m.usableDiameter}`
    : `usable ${m.usableWidth} x ${m.usableHeight}`;
  console.log(`${m.id}: ${m.width} x ${m.height} x ${m.thickness} mm, ${usable}, ${m.triangles} triangles`);
}
console.log();

let designId = null;

await check('POST /api/designs stores a design', async () => {
  const r = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { colourDepth: 1.2, cell: 0.6, layers: [{ kind: 'text', text: 'BIMBY' }] },
      maskPng: maskB64,
      previewPng: previewB64,
    }),
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.id, 'expected an id');
  designId = r.body.id;
});

await check('/api/models lists every model this shop builds', async () => {
  const r = await json('/api/models');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((m) => m.id), ['cover', 'base']);
  const round = r.body.find((m) => m.id === 'base');
  assert.equal(round.round, true, 'the base must be recognised as a round face');
  assert.equal(round.usableWidth, round.usableHeight, 'a disc is as wide as it is tall');
  assert.equal(round.usableDiameter, round.usableWidth);
  assert.equal(r.body.find((m) => m.id === 'cover').round, false);
});

await check('/api/template answers for whichever model is asked for', async () => {
  const a = await json('/api/template?model=base');
  assert.equal(a.status, 200);
  assert.equal(a.body.id, 'base');
  // No ?model= predates the second model, so it still answers for the first.
  const b = await json('/api/template');
  assert.equal(b.body.id, 'cover');
});

await check('a design naming a model this shop cannot build is refused', async () => {
  const r = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { model: 'tm6-lid', colourDepth: 1.2, cell: 0.6 },
      maskPng: maskB64,
    }),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /tm6-lid/);
});

await check('a design with no model at all falls back to the first', async () => {
  const r = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { colourDepth: 1.2, cell: 0.6 }, maskPng: maskB64 }),
  });
  assert.equal(r.status, 201);
  const rec = await json(`/api/designs/${r.body.id}`);
  assert.equal(rec.body.model, 'cover');
});

// The whole point of the second model: it is built on its own mesh, and its
// round face cuts the design back to the disc exactly as the preview did.
await check('a design on the round base is built on the base, inside its disc', async () => {
  const created = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The coarsest contour the server allows: this mask is a slab, and a fine
    // grid over it would make a needlessly enormous file for one assertion.
    body: JSON.stringify({
      config: { model: 'base', colourDepth: 0.8, cell: 1.5 },
      maskPng: baseMaskB64,
    }),
  });
  assert.equal(created.status, 201);

  const { res } = await printFileFor(created.body.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-model-id'), 'base');

  const box = measureSTL(Buffer.from(await res.arrayBuffer()));
  assert.ok(box.count > 0, 'the design must produce geometry');

  const { face } = await loadModel('base');
  let maxR = 0;
  const buf = Buffer.from(await (await fetch(`${base}/admin/designs/${created.body.id}/model.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  })).arrayBuffer());
  for (let t = 0; t < box.count; t++) {
    const o = 84 + t * 50;
    for (let i = 0; i < 3; i++) {
      maxR = Math.max(maxR, Math.hypot(
        buf.readFloatLE(o + 12 + i * 12) - face.cx,
        buf.readFloatLE(o + 16 + i * 12) - face.cy,
      ));
    }
  }

  // Unclipped, this mask's corners would land 108.7 mm out. The contour can
  // sit up to half a cell past the clip, so allow that and no more.
  assert.ok(
    maxR <= face.clip + 1.5,
    `design must be cut to the disc, reached ${maxR.toFixed(2)} of ${face.clip.toFixed(2)} mm`,
  );
  // And it must actually reach the edge, not have been quietly shrunk.
  assert.ok(maxR > face.clip - 3, `design should reach the disc edge, got ${maxR.toFixed(2)}`);

  // Built on the base's own face: it starts at that plane and runs inward.
  assert.ok(Math.abs(box.minZ) < 0.01, `must start at the face, got ${box.minZ.toFixed(3)}`);
  assert.ok(Math.abs(box.maxZ - 0.8) < 0.01, `must run 0.8 mm inward, got ${box.maxZ.toFixed(3)}`);
});

await check('a cover mask is refused for the base, whose face is square', async () => {
  const r = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { model: 'base', colourDepth: 1 }, maskPng: maskB64 }),
  });
  assert.equal(r.status, 201, 'the aspect is only checked when the STL is built');
  const stl = await json(`/admin/designs/${r.body.id}/model.stl?force=1`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(stl.status, 422);
  assert.match(stl.body.error, /aspect/i);
});

await check('a mask with the wrong aspect ratio is refused at fulfilment', async () => {
  const bad = makeMaskPng(100, 100).toString('base64');
  const created = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { colourDepth: 1 }, maskPng: bad }),
  });
  assert.equal(created.status, 201);
  const stl = await json(`/admin/designs/${created.body.id}/model.stl?force=1`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(stl.status, 422);
  assert.match(stl.body.error, /aspect/i);
});

await check('non-PNG upload is rejected', async () => {
  const r = await json('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { relief: 1 },
      maskPng: Buffer.from('this is not a png at all').toString('base64'),
    }),
  });
  assert.equal(r.status, 400);
});

await check('the STL is not reachable without the admin token', async () => {
  const r = await json(`/admin/designs/${designId}/model.stl`);
  assert.equal(r.status, 401);
});

await check('a wrong admin token is rejected', async () => {
  const r = await json(`/admin/designs/${designId}/model.stl`, {
    headers: { Authorization: 'Bearer not-the-token' },
  });
  assert.equal(r.status, 401);
});

await check('the preview is public but the design record hides internals', async () => {
  const png = await fetch(`${base}/api/designs/${designId}/preview.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const rec = await json(`/api/designs/${designId}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.maskPng, undefined);
});

await check('an unsigned webhook is refused', async () => {
  const body = JSON.stringify({ id: 1, line_items: [] });
  const r = await json('/webhooks/shopify/orders-create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(r.status, 401);
});

await check('a webhook signed with the wrong secret is refused', async () => {
  const body = JSON.stringify({ id: 2, line_items: [] });
  const bad = crypto.createHmac('sha256', 'wrong').update(body).digest('base64');
  const r = await json('/webhooks/shopify/orders-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': bad },
    body,
  });
  assert.equal(r.status, 401);
});

await check('a signed order is filed for review with its design linked', async () => {
  const body = JSON.stringify({
    id: 5001, order_number: 1042, email: 'cliente@example.com',
    created_at: new Date().toISOString(),
    line_items: [{
      title: 'Capa TM7 personalizada', quantity: 1,
      properties: [
        { name: '_design_id', value: designId },
        { name: 'Pré-visualização', value: 'https://example.com/p.png' },
      ],
    }],
  });
  const r = await json('/webhooks/shopify/orders-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': sign(body) },
    body,
  });
  assert.equal(r.status, 200);

  const order = await store.getOrder('5001');
  assert.equal(order.status, 'pending_review');
  assert.deepEqual(order.designIds, [designId]);
});

await check('an unapproved order will not release a print file', async () => {
  const r = await json(`/admin/designs/${designId}/model.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(r.status, 409);
});

await check('approving the order releases a valid design body', async () => {
  const upd = await json('/admin/orders/5001/status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(upd.status, 200);

  const res = await fetch(`${base}/admin/designs/${designId}/model.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());

  // Parse it back rather than trusting the byte count.
  const count = buf.readUInt32LE(80);
  assert.equal(buf.length, 84 + count * 50, 'STL length must match its triangle count');
  assert.ok(count > 0, 'the design must produce geometry');

  let minZ = Infinity, maxZ = -Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    for (let i = 0; i < 3; i++) {
      minX = Math.min(minX, buf.readFloatLE(o + 12 + i * 12));
      maxX = Math.max(maxX, buf.readFloatLE(o + 12 + i * 12));
      minY = Math.min(minY, buf.readFloatLE(o + 16 + i * 12));
      maxY = Math.max(maxY, buf.readFloatLE(o + 16 + i * 12));
      const z = buf.readFloatLE(o + 20 + i * 12);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }

  // There is no relief: the design's surface sits on the face plane and the
  // body runs inward, so nothing may sit proud of it.
  assert.ok(Math.abs(minZ) < 0.01, `design must start at the face, got ${minZ.toFixed(3)}`);
  assert.ok(Math.abs(maxZ - 1.2) < 0.01, `design must run 1.2 mm inward, got ${maxZ.toFixed(3)}`);

  // And it must stay inside the usable area of the cover.
  assert.ok(maxX - minX <= info.usableWidth + 0.01, 'design wider than the usable area');
  assert.ok(maxY - minY <= info.usableHeight + 0.01, 'design taller than the usable area');
});

// Every model's black body is served on its own, and none of them is touched
// on the way out: the measurements are what make the part fit the machine.
for (const [id, file, slug] of [
  ['', 'tm7-cover.stl', 'capa-tm7'],
  ['cover', 'tm7-cover.stl', 'capa-tm7'],
  ['base', 'tm7-base.stl', 'base-tm7'],
]) {
  const what = id || 'no ?model= (the first)';
  await check(`the black body for ${what} is served byte-for-byte`, async () => {
    const res = await fetch(`${base}/admin/cover.stl${id ? `?model=${id}` : ''}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), new RegExp(`${slug}-preto\\.stl`));
    const buf = Buffer.from(await res.arrayBuffer());
    const source = await fs.readFile(new URL(`../../assets/model/${file}`, import.meta.url));
    const n = source.readUInt32LE(80);
    assert.equal(buf.readUInt32LE(80), n, 'must carry exactly the model triangles');
    assert.equal(
      Buffer.compare(source.subarray(84, 84 + n * 50), buf.subarray(84, 84 + n * 50)), 0,
      'model triangles must be unchanged',
    );
  });
}

await check('an unknown model has no black body to serve', async () => {
  const r = await json('/admin/cover.stl?model=tm6-lid', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(r.status, 404);
});

await check('the cover needs a token too', async () => {
  const r = await fetch(`${base}/admin/cover.stl`);
  assert.equal(r.status, 401);
});

await check('rejecting an order locks the print file again', async () => {
  await json('/admin/orders/5001/status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', note: 'copyrighted logo' }),
  });
  const r = await json(`/admin/designs/${designId}/model.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(r.status, 409);
});

await check('the queue says which model each order needs', async () => {
  const r = await json('/admin/queue', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(r.status, 200);
  const withDesigns = r.body.filter((o) => o.designIds && o.designIds.length);
  assert.ok(withDesigns.length, 'expected orders carrying designs');
  for (const o of withDesigns) {
    assert.ok(o.models && o.models.length, `order ${o.orderId} must name its models`);
    for (const id of o.models) assert.ok(['cover', 'base'].includes(id), `bad model ${id}`);
  }
  assert.ok(
    withDesigns.some((o) => o.models.includes('base')),
    'the base order must be reported as needing the base',
  );
});

await check('the review queue is filterable', async () => {
  const r = await json('/admin/queue?status=rejected', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].note, 'copyrighted logo');
});

await check('a traversal attempt in an id finds nothing', async () => {
  const r = await fetch(`${base}/api/designs/${encodeURIComponent('../../package')}`);
  assert.equal(r.status, 404);
});

await check('the console page is served without a token', async () => {
  const r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const body = await r.text();
  assert.match(body, /Encomendas/);
  // The page must ship no credential of its own.
  assert.ok(!body.includes(ADMIN_TOKEN), 'console must not embed the admin token');
});

await check('serving the console did not open up the data routes', async () => {
  for (const path of ['/admin/queue', '/admin/orders/5001/status', `/admin/designs/${designId}/model.stl`]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 401, `${path} should still require a token`);
  }
});

// ---------------------------------------------------------------------------

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed`);

server.close();
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);

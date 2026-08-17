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
const { templateInfo } = await import('../src/render.js');

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

const info = await templateInfo();

function makeMaskPng(wmm, hmm, ppm = 5) {
  const w = Math.round(wmm * ppm);
  const h = Math.round(hmm * ppm);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = x > w * 0.25 && x < w * 0.75 && y > h * 0.40 && y < h * 0.60;
      const i = (y * w + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = on ? 255 : 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const maskB64 = makeMaskPng(info.usableWidth, info.usableHeight).toString('base64');
const previewB64 = makeMaskPng(40, 30).toString('base64');

const sign = (body) =>
  crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

// --- tests -----------------------------------------------------------------

console.log(`template: ${info.width} x ${info.height} mm, usable ${info.usableWidth} x ${info.usableHeight}, ${info.triangles} triangles\n`);

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

await check('the cover is served separately and byte-for-byte', async () => {
  const res = await fetch(`${base}/admin/cover.stl`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  const source = await fs.readFile(new URL('../../assets/model/tm7-cover.stl', import.meta.url));
  const n = source.readUInt32LE(80);
  assert.equal(buf.readUInt32LE(80), n, 'cover must carry exactly the template triangles');
  assert.equal(
    Buffer.compare(source.subarray(84, 84 + n * 50), buf.subarray(84, 84 + n * 50)), 0,
    'template triangles must be unchanged',
  );
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

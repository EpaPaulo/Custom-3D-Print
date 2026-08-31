import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { config, assertRuntimeConfig } from './config.js';
import * as store from './store.js';
import {
  catalogue, describe, renderSTL, slug, normaliseSpec, SpecError,
} from './render.js';

// Read once: it is a fixed asset, and a failure to find it should stop the
// process at startup rather than 500 on the first person trying to log in.
const ADMIN_UI = readFileSync(new URL('./admin-ui.html', import.meta.url), 'utf8');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // -------------------------------------------------------------------------
  // Webhooks. Registered before any JSON parser: the signature covers the raw
  // bytes, so the body must not be reinterpreted before it is verified.
  // -------------------------------------------------------------------------

  app.post('/webhooks/shopify/orders-create',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req, res) => {
      if (!verifyShopifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'))) {
        return res.status(401).json({ error: 'bad signature' });
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'bad json' });
      }

      try {
        await recordOrder(payload);
      } catch (err) {
        // Shopify retries on non-2xx, which is what we want for a transient
        // failure — but log loudly, because a stuck order is a missed sale.
        console.error('[webhook] failed to record order', err);
        return res.status(500).json({ error: 'internal' });
      }
      res.json({ ok: true });
    });

  // -------------------------------------------------------------------------
  // Storefront API
  // -------------------------------------------------------------------------

  const api = express.Router();
  api.use(cors);
  api.use(express.json({ limit: config.maxBodyBytes + config.maxPreviewBytes }));

  api.get('/health', (_req, res) => res.json({ ok: true }));

  // Shapes, systems and limits, so a storefront can build the whole form from
  // what this side will actually accept.
  api.get('/catalogue', (_req, res) => res.json(catalogue()));

  // What a spec comes to: dimensions, stud count, file size and a price. The
  // configurator computes the same numbers locally for its own preview; this
  // is the copy that decides, and the one a shop quotes from.
  api.post('/plates', (req, res, next) => {
    try {
      res.json(describe(req.body || {}));
    } catch (err) {
      if (err instanceof SpecError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // The print file. Guarded by default: in a shop this is the product, not a
  // preview. ALLOW_PUBLIC_STL opens it for the open generator, where the
  // browser builds the identical file for itself anyway.
  api.post('/plates/stl', (req, res, next) => {
    if (!config.allowPublicSTL && !isAdmin(req)) {
      return res.status(403).json({ error: 'STL generation is not public on this server' });
    }
    try {
      // Normalise first so the filename and the geometry come from the same
      // numbers, and so a large plate is only built once.
      const spec = normaliseSpec(req.body || {});
      sendSTL(res, renderSTL(spec, 'lego-compatible plate'), `${slug(spec)}.stl`);
    } catch (err) {
      if (err instanceof SpecError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Keep a design so an order can refer to it later by id alone.
  api.post('/designs', async (req, res, next) => {
    try {
      const { spec, previewPng, note } = req.body || {};
      if (!spec || typeof spec !== 'object') {
        return res.status(400).json({ error: 'spec is required' });
      }

      // Build it now. A spec that cannot be built is refused at design time
      // rather than at fulfilment, when there is a paying customer waiting.
      const described = describe(spec);

      const preview = decodeBase64Png(previewPng, config.maxPreviewBytes);

      const record = await store.putDesign({
        spec: described.spec,
        size: described.size,
        studs: described.studs,
        quote: described.quote,
        note: typeof note === 'string' ? note.slice(0, 500) : '',
      }, preview);

      res.status(201).json({
        id: record.id,
        size: described.size,
        studs: described.studs,
        quote: described.quote,
        previewUrl: preview ? `/api/designs/${record.id}/preview.png` : null,
      });
    } catch (err) {
      if (err instanceof SpecError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Public: the customer must be able to see what they ordered. Deliberately
  // does NOT expose the STL — that is the product, not the receipt.
  api.get('/designs/:id', async (req, res, next) => {
    try {
      const d = await store.getDesign(req.params.id);
      if (!d) return res.status(404).json({ error: 'not found' });
      res.json(d);
    } catch (err) { next(err); }
  });

  api.get('/designs/:id/preview.png', async (req, res, next) => {
    try {
      const png = await store.getDesignPreview(req.params.id);
      if (!png) return res.status(404).json({ error: 'not found' });
      res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable').send(png);
    } catch (err) { next(err); }
  });

  app.use('/api', api);

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  const admin = express.Router();
  admin.use(express.json({ limit: config.maxBodyBytes }));
  admin.use(requireAdmin);

  admin.get('/orders', async (req, res, next) => {
    try {
      res.json(await store.listOrders({ status: req.query.status }));
    } catch (err) { next(err); }
  });

  admin.get('/orders/:orderId', async (req, res, next) => {
    try {
      const order = await store.getOrder(req.params.orderId);
      if (!order) return res.status(404).json({ error: 'not found' });
      res.json(order);
    } catch (err) { next(err); }
  });

  admin.post('/orders/:orderId/status', async (req, res, next) => {
    try {
      const { status, note } = req.body || {};
      if (!['new', 'approved', 'printed', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'unknown status' });
      }
      const order = await store.setOrderStatus(req.params.orderId, status, note);
      if (!order) return res.status(404).json({ error: 'not found' });
      res.json(order);
    } catch (err) { next(err); }
  });

  // The print file for a stored design. This is the whole point of the admin
  // side: everything else is bookkeeping around getting this onto a printer.
  admin.get('/designs/:id/plate.stl', async (req, res, next) => {
    try {
      const design = await store.getDesign(req.params.id);
      if (!design) return res.status(404).json({ error: 'not found' });
      const stl = renderSTL(design.spec, 'lego-compatible plate');
      sendSTL(res, stl, `${slug(design.spec)}-${design.id}.stl`);
    } catch (err) {
      if (err instanceof SpecError) return res.status(422).json({ error: err.message });
      next(err);
    }
  });

  app.use('/api/admin', admin);

  // The console itself is not secret — everything it can reach needs the token
  // anyway, and it asks for one on load.
  app.get('/admin', (_req, res) => res.type('html').send(ADMIN_UI));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Turn a Shopify order into something a print shop can work from.
 *
 * Line items carry the design id in their properties, put there by the
 * storefront when the customer added the plate to the basket. An item without
 * one is not a personalised plate and is skipped rather than guessed at.
 */
async function recordOrder(payload) {
  const items = [];

  for (const line of payload.line_items || []) {
    const id = designIdOf(line);
    if (!id) continue;

    const design = await store.getDesign(id);
    items.push({
      lineItemId: line.id,
      title: line.title,
      quantity: line.quantity,
      designId: id,
      // Copied, not referenced: an order is a record of what was bought, and
      // it must still read correctly if the design file is ever lost.
      spec: design ? design.spec : null,
      size: design ? design.size : null,
      missing: !design,
    });
  }

  if (!items.length) return null;

  return store.putOrder({
    orderId: String(payload.id),
    orderNumber: payload.order_number ?? payload.name ?? null,
    createdAt: payload.created_at || new Date().toISOString(),
    customer: {
      name: [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') || null,
      email: payload.email || payload.customer?.email || null,
    },
    items,
    status: 'new',
  });
}

function designIdOf(line) {
  for (const prop of line.properties || []) {
    const name = String(prop.name || '').toLowerCase();
    if (name === 'design' || name === 'design_id' || name === '_design_id') {
      const value = String(prop.value || '');
      if (store.isValidId(value)) return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function verifyShopifyHmac(raw, header) {
  if (!config.webhookSecret || !header || !Buffer.isBuffer(raw)) return false;
  const digest = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest();
  let given;
  try {
    given = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  // Lengths must match before timingSafeEqual will look at the contents, and
  // comparing them first leaks nothing a wrong-length signature does not.
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}

const bearer = (req) => {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : '';
};

function isAdmin(req) {
  const token = bearer(req);
  if (!token || !config.adminToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorised' });
  next();
}

// Only the storefronts named in the environment may create designs. An unknown
// origin gets no CORS headers at all, which is what stops a browser using it.
function cors(req, res, next) {
  const origin = req.get('Origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function sendSTL(res, buffer, filename) {
  res.type('model/stl')
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(buffer);
}

function decodeBase64Png(value, limit) {
  if (typeof value !== 'string' || !value) return null;
  const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  // Check the encoded length before decoding: a limit enforced after the
  // allocation is not a limit.
  if (base64.length > limit * 1.4) return null;
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length || buf.length > limit) return null;
  // A PNG and nothing else, checked by its own magic rather than by trusting
  // whatever the data URI claimed.
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buf.subarray(0, 8).equals(magic) ? buf : null;
}

// Started directly rather than imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  assertRuntimeConfig();
  await store.init();
  createApp().listen(config.port, () => {
    console.log(`lego-plate-shop listening on :${config.port}`);
  });
}

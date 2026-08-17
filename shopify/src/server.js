import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { config, assertRuntimeConfig } from './config.js';
import * as store from './store.js';
import {
  renderDesignSTL, renderCoverSTL, templateInfo, decodeMask, RenderError,
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
  api.use(express.json({ limit: config.maxUploadBytes }));

  api.get('/template', async (_req, res, next) => {
    try {
      res.json(await templateInfo());
    } catch (err) { next(err); }
  });

  api.post('/designs', async (req, res, next) => {
    try {
      const { config: design, maskPng, previewPng } = req.body || {};
      if (!design || typeof design !== 'object') {
        return res.status(400).json({ error: 'config is required' });
      }

      const mask = decodeBase64Png(maskPng, config.maxUploadBytes);
      if (!mask) return res.status(400).json({ error: 'maskPng is required' });

      // Decode eagerly so a broken mask is rejected at design time rather than
      // at fulfilment, when there is a paying customer waiting.
      decodeMask(mask);

      const preview = decodeBase64Png(previewPng, config.maxPreviewBytes);

      const record = await store.putDesign({
        colourDepth: design.colourDepth,
        cell: design.cell,
        // Kept for support and re-editing. Never used to build geometry.
        layers: Array.isArray(design.layers) ? design.layers.slice(0, 40) : [],
        note: typeof design.note === 'string' ? design.note.slice(0, 500) : '',
      }, mask, preview);

      res.status(201).json({
        id: record.id,
        previewUrl: preview ? `/api/designs/${record.id}/preview.png` : null,
      });
    } catch (err) {
      if (err instanceof RenderError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Public: the customer must be able to see what they ordered. Deliberately
  // does NOT expose the STL — that is the product, not the receipt.
  api.get('/designs/:id', async (req, res, next) => {
    try {
      const d = await store.getDesign(req.params.id);
      if (!d) return res.status(404).json({ error: 'not found' });
      res.json({ id: d.id, createdAt: d.createdAt, colourDepth: d.colourDepth, layers: d.layers });
    } catch (err) { next(err); }
  });

  api.get('/designs/:id/preview.png', async (req, res, next) => {
    try {
      const png = await store.getDesignFile(req.params.id, 'preview');
      if (!png) return res.status(404).end();
      res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable').send(png);
    } catch (err) { next(err); }
  });

  app.use('/api', api);

  // -------------------------------------------------------------------------
  // Admin — everything that can reach a print file
  // -------------------------------------------------------------------------

  // The console itself carries no data, so it is served without a token; it
  // asks for one and sends it on every request below. Registered ahead of the
  // admin router so the page is reachable in order to log in at all.
  app.get('/admin', (_req, res) => {
    res.type('html').set('Cache-Control', 'no-store').send(ADMIN_UI);
  });

  const admin = express.Router();
  admin.use(requireAdmin);
  admin.use(express.json({ limit: '1mb' }));

  admin.get('/queue', async (req, res, next) => {
    try {
      res.json(await store.listOrders({ status: req.query.status }));
    } catch (err) { next(err); }
  });

  admin.post('/orders/:id/status', async (req, res, next) => {
    try {
      const { status, note } = req.body || {};
      if (!['approved', 'rejected', 'printed', 'pending_review'].includes(status)) {
        return res.status(400).json({ error: 'unknown status' });
      }
      const order = await store.setOrderStatus(req.params.id, status, note);
      if (!order) return res.status(404).json({ error: 'not found' });
      res.json(order);
    } catch (err) { next(err); }
  });

  // The black cover. Identical for every order, so it is fetched once and kept
  // rather than reissued per design.
  admin.get('/cover.stl', async (_req, res, next) => {
    try {
      const { buffer, triangles } = await renderCoverSTL();
      res
        .type('model/stl')
        .set('X-Triangle-Count', String(triangles))
        .set('Content-Disposition', 'attachment; filename="capa-tm7-preto.stl"')
        .send(Buffer.from(buffer));
    } catch (err) { next(err); }
  });

  // The per-order print file: the white design body. Gated behind the admin
  // token, and behind approval — an unreviewed design must not reach a printer.
  admin.get('/designs/:id/model.stl', async (req, res, next) => {
    try {
      const design = await store.getDesign(req.params.id);
      if (!design) return res.status(404).json({ error: 'not found' });

      if (req.query.force !== '1') {
        const orders = await store.listOrders();
        const linked = orders.filter((o) => o.designIds.includes(design.id));
        if (linked.length && !linked.some((o) => o.status === 'approved')) {
          return res.status(409).json({
            error: 'design belongs to an order that has not been approved',
          });
        }
      }

      const maskPng = await store.getDesignFile(design.id, 'mask');
      if (!maskPng) return res.status(410).json({ error: 'mask missing' });

      const { buffer, triangles } = await renderDesignSTL(design, maskPng);
      res
        .type('model/stl')
        .set('X-Triangle-Count', String(triangles))
        .set('Content-Disposition', `attachment; filename="desenho-${design.id}-branco.stl"`)
        .send(Buffer.from(buffer));
    } catch (err) {
      if (err instanceof RenderError) return res.status(422).json({ error: err.message });
      next(err);
    }
  });

  app.use('/admin', admin);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cors(req, res, next) {
  const origin = req.get('Origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function requireAdmin(req, res, next) {
  const given = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = config.adminToken;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorised' });
  }
  next();
}

export function verifyShopifyHmac(rawBody, header) {
  if (!config.webhookSecret || !header || !Buffer.isBuffer(rawBody)) return false;
  const digest = crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(String(header), 'base64');
  } catch {
    return false;
  }
  return digest.length === given.length && crypto.timingSafeEqual(digest, given);
}

function decodeBase64Png(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null;
  const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length || buf.length > maxBytes) return null;
  // PNG magic — reject anything that is not actually an image.
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return buf;
}

// Pull the design ids off the line items and file the order for review.
export async function recordOrder(payload) {
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  const designIds = [];
  const lines = [];

  for (const item of items) {
    const props = Array.isArray(item.properties) ? item.properties : [];
    const found = props.find((p) => p && p.name === '_design_id');
    const id = found && store.isValidId(found.value) ? found.value : null;
    if (id && !designIds.includes(id)) designIds.push(id);
    lines.push({ title: item.title, quantity: item.quantity, designId: id });
  }

  return store.putOrder({
    orderId: String(payload.id),
    orderNumber: payload.order_number ?? null,
    createdAt: payload.created_at || new Date().toISOString(),
    email: payload.email || null,
    designIds,
    lines,
    // Personalised goods get printed and cannot be resold, so every order
    // passes a human before it reaches a printer.
    status: designIds.length ? 'pending_review' : 'no_design',
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  assertRuntimeConfig();
  await store.init();
  createApp().listen(config.port, () => {
    console.log(`listening on :${config.port}`);
  });
}

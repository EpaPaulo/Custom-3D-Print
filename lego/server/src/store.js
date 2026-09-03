// Filesystem-backed storage.
//
// A print shop's order volume is bounded by printer hours, not by database
// throughput, so files on disk are the right size of tool here: no daemon to
// run, no migrations, and the whole state is inspectable with `ls` and `cat`.
// Writes go through a temp file and rename so a crash cannot leave a torn
// record behind.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const designDir = () => path.join(config.dataDir, 'designs');
const orderDir = () => path.join(config.dataDir, 'orders');

export async function init() {
  await fs.mkdir(designDir(), { recursive: true });
  await fs.mkdir(orderDir(), { recursive: true });
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Ids appear in URLs and line item properties, so keep them opaque and
// filesystem-safe, and never interpolate a caller's string into a path.
export const newId = () => randomUUID().replace(/-/g, '').slice(0, 20);

const VALID_ID = /^[a-f0-9]{20}$/;
export const isValidId = (id) => typeof id === 'string' && VALID_ID.test(id);

// --- designs ---------------------------------------------------------------

export async function putDesign(design, previewPng) {
  const id = newId();
  const record = { id, createdAt: new Date().toISOString(), ...design };
  if (previewPng) {
    await writeAtomic(path.join(designDir(), `${id}-preview.png`), previewPng);
  }
  await writeAtomic(path.join(designDir(), `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

export async function getDesign(id) {
  if (!isValidId(id)) return null;
  return readJson(path.join(designDir(), `${id}.json`));
}

export async function getDesignPreview(id) {
  if (!isValidId(id)) return null;
  try {
    return await fs.readFile(path.join(designDir(), `${id}-preview.png`));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// --- orders ----------------------------------------------------------------

const orderFile = (orderId) => path.join(orderDir(), `${String(orderId).replace(/[^\w.-]/g, '_')}.json`);

export async function putOrder(order) {
  await writeAtomic(orderFile(order.orderId), JSON.stringify(order, null, 2));
  return order;
}

export async function getOrder(orderId) {
  return readJson(orderFile(orderId));
}

export async function listOrders({ status } = {}) {
  let names;
  try {
    names = await fs.readdir(orderDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = await readJson(path.join(orderDir(), name));
    if (rec && (!status || rec.status === status)) out.push(rec);
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export async function setOrderStatus(orderId, status, note) {
  const order = await getOrder(orderId);
  if (!order) return null;
  order.status = status;
  order.reviewedAt = new Date().toISOString();
  if (note !== undefined) order.note = note;
  return putOrder(order);
}

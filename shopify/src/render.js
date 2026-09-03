// Server-side STL generation.
//
// The browser sends the *rasterised stamp mask*, not a font name and not a
// finished STL. That choice matters twice over:
//
//   - Fidelity. Rendering text server-side would need the same fonts installed
//     as the customer's browser had; when they differ, the print quietly stops
//     matching the preview the customer approved. A bitmap cannot drift.
//   - Safety. A mask is just a bounded greyscale image. The geometry is still
//     built here, by our own code, from the fixed models — so a customer can
//     never hand us arbitrary triangles to put on a printer.
//
// Every design names the model it was built on. That name picks the mesh, the
// face, and the usable area the mask is measured against, so a design can only
// ever be built on the model the customer actually saw.

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { config, defaultModelId, modelById } from './config.js';
import {
  parseSTL, analyseFace, buildInlaySolid, buildExportSTL,
} from '../../assets/js/template.js';
import { buildSAT } from '../../assets/js/geom.js';

export class RenderError extends Error {}

/**
 * Which model a value names. Anything the registry does not know is refused
 * rather than quietly built on the default: a design fulfilled on the wrong
 * mesh would only show once someone had paid for it.
 */
export function resolveModelId(value) {
  // Designs recorded before the second model existed carry no id at all.
  if (value == null || value === '') return defaultModelId;
  if (!modelById(value)) {
    const known = config.models.map((m) => m.id).join(', ');
    // Whatever came in is echoed back to say what was rejected, so bound it:
    // the id arrives in a request body and an error is no place for an essay.
    const shown = String(value).slice(0, 40);
    throw new RenderError(`Unknown model "${shown}". This shop builds: ${known}.`);
  }
  return value;
}

// Meshes are a few megabytes each and never change, so each is parsed once and
// kept. A shop that only ever sells one never pays for the other.
const cache = new Map();

export async function loadModel(id) {
  const modelId = resolveModelId(id);
  if (cache.has(modelId)) return cache.get(modelId);
  const spec = modelById(modelId);
  const buf = await readFile(spec.path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const template = parseSTL(ab);
  const entry = { spec, template, face: analyseFace(template.positions) };
  cache.set(modelId, entry);
  return entry;
}

export function decodeMask(pngBuffer) {
  let png;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch {
    throw new RenderError('Mask is not a readable PNG.');
  }
  const { width: w, height: h, data } = png;
  if (w * h > config.maxMaskPixels) {
    throw new RenderError(`Mask is too large (${w}x${h}).`);
  }
  const gray = new Float32Array(w * h);
  // The mask is drawn white-on-black, so any channel will do; red is fine.
  for (let i = 0, k = 0; k < gray.length; i += 4, k++) gray[k] = data[i] / 255;
  return { data: gray, w, h };
}

/**
 * Build the per-order print file: the white design body alone.
 *
 * The black body is identical for every order of a given model, so it is not
 * reissued each time — fetch it once from renderCoverSTL(design.model). Load
 * the two into the slicer as one object with two parts and assign a filament
 * to each; they share a coordinate system, so they land aligned.
 */
export async function renderDesignSTL(design, maskPng) {
  const { spec, face } = await loadModel(design.model);
  const { data, w, h } = decodeMask(maskPng);

  // The mask is expected to cover exactly the usable design area. Checking the
  // aspect ratio catches a mask built against different assumptions, which
  // would otherwise silently scale the artwork.
  const expected = face.safeWidth / face.safeHeight;
  const got = w / h;
  if (Math.abs(got - expected) / expected > 0.02) {
    throw new RenderError(
      `Mask aspect ${got.toFixed(3)} does not match the usable area ${expected.toFixed(3)}.`,
    );
  }

  const colourDepth = clamp(
    design.colourDepth ?? design.relief, config.colourMin, config.colourMax,
  );
  const cell = clamp(design.cell ?? 0.5, config.cellMin, config.cellMax);

  const mask = {
    data, w, h,
    pxPerMm: w / face.safeWidth,
    faceW: face.safeWidth,
    faceH: face.safeHeight,
    sat: buildSAT(data, w, h),
  };

  // `clip` is what holds a design inside a round face. The browser preview
  // applies it, so leaving it out here would print something the customer
  // never approved — artwork running off the edge of the disc.
  const surface = {
    z: face.z, cx: face.cx, cy: face.cy, dir: -1, mirror: true, clip: face.clip,
  };
  const inlay = buildInlaySolid(surface, mask, colourDepth, cell);
  if (!inlay.length) throw new RenderError('Design is empty — nothing to print.');

  return writeSTL(inlay, `desenho ${spec.slug}`);
}

/** The black body: the supplied mesh, copied through byte for byte. */
export async function renderCoverSTL(modelId) {
  const { spec, template } = await loadModel(modelId);
  const { buffer, triangles } = buildExportSTL(
    template.source, template.triangles, null, spec.slug,
  );
  return { buffer, triangles, spec };
}

// A plain binary STL for geometry we generated ourselves.
function writeSTL(positions, header) {
  const tri = positions.length / 9;
  const out = new ArrayBuffer(84 + tri * 50);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  for (let i = 0; i < header.length && i < 79; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, tri, true);

  let off = 84;
  for (let t = 0; t < tri; t++) {
    const o = t * 9;
    const ux = positions[o + 3] - positions[o];
    const uy = positions[o + 4] - positions[o + 1];
    const uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o];
    const vy = positions[o + 7] - positions[o + 1];
    const vz = positions[o + 8] - positions[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    for (let i = 0; i < 9; i++) view.setFloat32(off + 12 + i * 4, positions[o + i], true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return { buffer: out, triangles: tri };
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export async function templateInfo(modelId) {
  const { spec, template, face } = await loadModel(modelId);
  return {
    id: spec.id,
    label: spec.label,
    // Names the files an operator downloads, so the console can match them.
    slug: spec.slug,
    triangles: template.triangles,
    width: round(face.width),
    height: round(face.height),
    thickness: round(face.thickness),
    cornerRadius: round(face.radius),
    // A round face has no corners and no inscribed rectangle worth quoting:
    // the usable area is the disc, and the two "sides" are its diameter.
    round: face.round,
    usableWidth: round(face.safeWidth),
    usableHeight: round(face.safeHeight),
    usableDiameter: face.round ? round(face.safeWidth) : null,
  };
}

/** Every model this shop can build, for a storefront picking between them. */
export async function modelsInfo() {
  return Promise.all(config.models.map((m) => templateInfo(m.id)));
}

const round = (v) => Math.round(v * 100) / 100;

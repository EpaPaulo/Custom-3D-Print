// Server-side STL generation.
//
// The browser sends the *rasterised stamp mask*, not a font name and not a
// finished STL. That choice matters twice over:
//
//   - Fidelity. Rendering text server-side would need the same fonts installed
//     as the customer's browser had; when they differ, the print quietly stops
//     matching the preview the customer approved. A bitmap cannot drift.
//   - Safety. A mask is just a bounded greyscale image. The geometry is still
//     built here, by our own code, from the fixed template — so a customer can
//     never hand us arbitrary triangles to put on a printer.

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { config } from './config.js';
import {
  parseSTL, analyseFace, buildInlaySolid, buildExportSTL,
} from '../../assets/js/template.js';
import { buildSAT } from '../../assets/js/geom.js';

let cached = null;

export async function loadTemplate() {
  if (cached) return cached;
  const buf = await readFile(config.templatePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const template = parseSTL(ab);
  const face = analyseFace(template.positions);
  cached = { template, face };
  return cached;
}

export class RenderError extends Error {}

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
 * The cover is identical for every order, so it is not reissued each time —
 * fetch it once from renderCoverSTL(). Load the two into the slicer as one
 * object with two parts and assign a filament to each; they share a coordinate
 * system, so they land aligned.
 */
export async function renderDesignSTL(design, maskPng) {
  const { template, face } = await loadTemplate();
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

  const surface = { z: face.z, cx: face.cx, cy: face.cy, dir: -1, mirror: true };
  const inlay = buildInlaySolid(surface, mask, colourDepth, cell);
  if (!inlay.length) throw new RenderError('Design is empty — nothing to print.');

  return writeSTL(inlay, 'desenho tm7');
}

/** The black cover: the supplied template, copied through byte for byte. */
export async function renderCoverSTL() {
  const { template } = await loadTemplate();
  return buildExportSTL(template.source, template.triangles, null, 'capa tm7');
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

export async function templateInfo() {
  const { template, face } = await loadTemplate();
  return {
    triangles: template.triangles,
    width: round(face.width),
    height: round(face.height),
    cornerRadius: round(face.radius),
    usableWidth: round(face.safeWidth),
    usableHeight: round(face.safeHeight),
  };
}

const round = (v) => Math.round(v * 100) / 100;

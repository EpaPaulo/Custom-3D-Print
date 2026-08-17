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
  parseSTL, analyseFace, buildStampSolid, buildExportSTL,
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
 * Build the print file for a stored design.
 * Returns { buffer, triangles } — the template verbatim plus the design body.
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

  const relief = clamp(design.relief, config.reliefMin, config.reliefMax);
  const cell = clamp(design.cell ?? 0.5, config.cellMin, config.cellMax);

  const mask = {
    data, w, h,
    pxPerMm: w / face.safeWidth,
    faceW: face.safeWidth,
    faceH: face.safeHeight,
    sat: buildSAT(data, w, h),
  };

  const slab = buildStampSolid(face, mask, relief, cell);
  if (!slab.length) throw new RenderError('Design is empty — nothing to print.');

  return buildExportSTL(template.source, template.triangles, slab, 'bimby tm7 cover');
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

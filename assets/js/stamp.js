// Stamp mask rendering.
//
// Every layer (text or image) is drawn white-on-black into a canvas that covers
// the cover's full face. The resulting grayscale becomes the displacement map,
// so antialiased edges turn into slightly bevelled edges on the print.

import { buildSAT } from './geom.js';

export const FONTS = [
  { id: 'sans', label: 'Sans', css: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", Times, serif' },
  { id: 'mono', label: 'Mono', css: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace' },
  { id: 'rounded', label: 'Rounded', css: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif' },
  { id: 'condensed', label: 'Condensed', css: '"Arial Narrow", "Helvetica Neue", Impact, sans-serif' },
];

export function fontCss(id) {
  const f = FONTS.find((x) => x.id === id);
  return f ? f.css : FONTS[0].css;
}

let nextId = 1;
export function newId() {
  return nextId++;
}

export function makeTextLayer() {
  return {
    id: newId(),
    kind: 'text',
    name: 'Text',
    text: 'BIMBY',
    font: 'sans',
    weight: 700,
    size: 18,        // mm cap height-ish (font pixel size in mm)
    tracking: 0,     // mm between letters
    lineGap: 1.25,   // multiple of size
    x: 0,
    y: 0,
    rotation: 0,
    visible: true,
  };
}

export function makeImageLayer(name, bitmapSource, aspect) {
  return {
    id: newId(),
    kind: 'image',
    name: name || 'Image',
    src: bitmapSource,   // HTMLImageElement
    aspect: aspect || 1, // width / height
    width: 60,           // mm
    threshold: 0.5,
    invert: false,
    useAlpha: true,
    x: 0,
    y: 0,
    rotation: 0,
    visible: true,
    _cache: null,
  };
}

// Convert an image into a white silhouette on transparent, honouring the
// threshold / invert / alpha settings. Cached until those settings change.
function silhouette(layer) {
  const key = `${layer.threshold}|${layer.invert}|${layer.useAlpha}`;
  if (layer._cache && layer._cache.key === key) return layer._cache.canvas;

  const img = layer.src;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  // Cap the working resolution; stamps never need more than this.
  const maxDim = 1024;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const src = document.createElement('canvas');
  src.width = cw;
  src.height = ch;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, cw, ch);

  const data = sctx.getImageData(0, 0, cw, ch);
  const px = data.data;
  const thr = layer.threshold;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    let on;
    if (layer.useAlpha && a < 0.999) {
      // Transparent PNG / SVG: the alpha channel *is* the shape.
      on = a > thr;
    } else {
      const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      // Dark ink on light paper reads as "on".
      on = lum < thr;
    }
    if (layer.invert) on = !on;
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = on ? 255 : 0;
  }

  sctx.putImageData(data, 0, 0);
  layer._cache = { key, canvas: src };
  return src;
}

function drawTextLayer(ctx, layer, pxPerMm) {
  const sizePx = layer.size * pxPerMm;
  if (sizePx < 1) return;

  ctx.font = `${layer.weight} ${sizePx}px ${fontCss(layer.font)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';

  const lines = String(layer.text).split('\n');
  const lineH = sizePx * layer.lineGap;
  const trackPx = layer.tracking * pxPerMm;
  const totalH = lineH * (lines.length - 1);

  lines.forEach((line, li) => {
    const y = -totalH / 2 + li * lineH;
    if (Math.abs(trackPx) < 0.01) {
      ctx.fillText(line, 0, y);
      return;
    }
    // Manual letter spacing: measure, then lay out glyph by glyph.
    const chars = Array.from(line);
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((s, w) => s + w, 0) + trackPx * (chars.length - 1);
    let cx = -total / 2;
    ctx.textAlign = 'left';
    chars.forEach((c, i) => {
      ctx.fillText(c, cx, y);
      cx += widths[i] + trackPx;
    });
    ctx.textAlign = 'center';
  });
}

function drawImageLayer(ctx, layer, pxPerMm) {
  const sil = silhouette(layer);
  if (!sil) return;
  const wPx = layer.width * pxPerMm;
  const hPx = wPx / (layer.aspect || 1);
  if (wPx < 1 || hPx < 1) return;
  ctx.drawImage(sil, -wPx / 2, -hPx / 2, wPx, hPx);
}

/**
 * Render all layers into a mask covering the face.
 * Returns { data, w, h, pxPerMm, sat, canvas } or null when nothing is stamped.
 */
export function renderMask(layers, faceW, faceH, cell) {
  const active = layers.filter((l) => l.visible !== false);
  if (!active.length) return null;

  // Roughly 3 mask pixels per grid cell keeps the box filter well fed.
  const pxPerMm = Math.min(14, Math.max(4, 3 / Math.max(cell, 0.05)));
  const w = Math.max(8, Math.round(faceW * pxPerMm));
  const h = Math.max(8, Math.round(faceH * pxPerMm));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  for (const layer of active) {
    ctx.save();
    // Layer origin is the face centre; +Y is up, canvas Y is down.
    ctx.translate(w / 2 + layer.x * pxPerMm, h / 2 - layer.y * pxPerMm);
    ctx.rotate((-layer.rotation * Math.PI) / 180);
    if (layer.kind === 'text') drawTextLayer(ctx, layer, pxPerMm);
    else drawImageLayer(ctx, layer, pxPerMm);
    ctx.restore();
  }

  const img = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  let any = false;
  for (let i = 0, k = 0; i < img.length; i += 4, k++) {
    const v = img[i] / 255; // red channel; everything is drawn white
    gray[k] = v;
    if (v > 0.01) any = true;
  }
  if (!any) return null;

  return { data: gray, w, h, pxPerMm, sat: buildSAT(gray, w, h), canvas };
}

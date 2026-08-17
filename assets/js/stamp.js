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

// Artwork is rarely one flat ink. A logo may be black type with gold
// ornaments, or white type on a dark field, and a plain luminance cutoff
// silently discards everything that is not near one end of the scale — gold
// sits around 0.62, so a 0.5 cutoff drops it and the design arrives missing
// half of itself.
//
// So the test is not "how dark is this pixel" but "how far is it from the
// background". The background is measured from the border, where artwork
// almost never reaches. That keeps every coloured element, and works
// unchanged on a dark field, where the old rule was exactly backwards.

const WORK_MAX = 2048;

function drawToWorkCanvas(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const scale = Math.min(1, WORK_MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, cw, ch);
  return { canvas, ctx, cw, ch };
}

// Median of the border ring, which is background in all but pathological art.
function backgroundColour(px, w, h) {
  const rs = [], gs = [], bs = [];
  const take = (x, y) => {
    const i = (y * w + x) * 4;
    if (px[i + 3] < 128) return; // transparent border tells us nothing
    rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
  };
  const stepX = Math.max(1, Math.floor(w / 128));
  const stepY = Math.max(1, Math.floor(h / 128));
  for (let x = 0; x < w; x += stepX) { take(x, 0); take(x, h - 1); }
  for (let y = 0; y < h; y += stepY) { take(0, y); take(w - 1, y); }
  if (!rs.length) return [255, 255, 255];
  const mid = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
  return [mid(rs), mid(gs), mid(bs)];
}

// Distance from the background, as the largest single-channel difference.
// Channel-wise beats luminance here: gold and white have similar brightness
// but are far apart in blue.
function distanceFrom(px, i, bg) {
  const dr = Math.abs(px[i] - bg[0]);
  const dg = Math.abs(px[i + 1] - bg[1]);
  const db = Math.abs(px[i + 2] - bg[2]);
  return Math.max(dr, dg, db) / 255;
}

/**
 * Pick the threshold that best separates artwork from background, by Otsu's
 * method over the distance histogram. Run once when an image is added, so the
 * slider starts somewhere sensible instead of at a guess that suits only
 * black-on-white.
 */
export function autoThreshold(img) {
  const work = drawToWorkCanvas(img);
  if (!work) return 0.5;
  const { ctx, cw, ch } = work;
  const px = ctx.getImageData(0, 0, cw, ch).data;

  // A mostly-transparent image is described by its alpha, not its colour.
  let opaque = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque++;
  if (opaque < (px.length / 4) * 0.98) return 0.5;

  const bg = backgroundColour(px, cw, ch);
  const hist = new Float64Array(256);
  for (let i = 0; i < px.length; i += 4) {
    hist[Math.round(distanceFrom(px, i, bg) * 255)]++;
  }

  const total = px.length / 4;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  // Artwork leaves a wide empty gap between the background spike and the ink,
  // so the variance is flat right across it and every threshold in the gap is
  // equally optimal. Taking the first would sit hard against the background
  // and sweep up antialiasing and compression noise; the midpoint of the
  // plateau is the threshold with the most room on either side.
  let sumB = 0, wB = 0, lo = 0, hi = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar * 1.000001) { bestVar = between; lo = t; hi = t; }
    else if (between >= bestVar * 0.999999) { hi = t; }
  }
  const best = (lo + hi) / 2;

  // Keep it off the extremes: a threshold at 0 keeps the background, and one
  // at 1 keeps nothing.
  return Math.min(0.9, Math.max(0.06, best / 255));
}

// Convert an image into a white silhouette on transparent, honouring the
// threshold / invert / alpha settings. Cached until those settings change.
function silhouette(layer) {
  const key = `${layer.threshold}|${layer.invert}|${layer.useAlpha}`;
  if (layer._cache && layer._cache.key === key) return layer._cache.canvas;

  const work = drawToWorkCanvas(layer.src);
  if (!work) return null;
  const { canvas, ctx, cw, ch } = work;

  const data = ctx.getImageData(0, 0, cw, ch);
  const px = data.data;
  const thr = layer.threshold;
  const bg = backgroundColour(px, cw, ch);

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    let on;
    if (layer.useAlpha && a < 0.999) {
      // Transparent PNG / SVG: the alpha channel *is* the shape.
      on = a > thr;
    } else {
      on = distanceFrom(px, i, bg) > thr;
    }
    if (layer.invert) on = !on;
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = on ? 255 : 0;
  }

  ctx.putImageData(data, 0, 0);
  layer._cache = { key, canvas };
  return canvas;
}

// ---------------------------------------------------------------------------
// Printability
//
// A colour change only stays crisp while the feature is a few nozzle widths
// across. Below that the two filaments smear into each other and fine detail
// arrives as a grey smudge — which the 3D preview will happily show as clean,
// because the geometry really is clean. The mesh is not the limit; the nozzle
// is. So the mask is measured before it becomes geometry.
// ---------------------------------------------------------------------------

// Two passes of chamfer distance. Exact Euclidean would cost more and buy
// nothing: this is feeding a threshold comparison, not a dimension.
function distanceToZero(bin, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = bin[i] ? INF : 0;

  const A = 1, B = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + A);
      if (y > 0) m = Math.min(m, d[i - w] + A);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + B);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + B);
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + A);
      if (y < h - 1) m = Math.min(m, d[i + w] + A);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + B);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + B);
      d[i] = m;
    }
  }
  return d;
}

/**
 * Measure the design against what a nozzle can hold.
 *
 * Two different failures, so two measurements:
 *   - a whole element too small to survive at all (the dot on an ornament),
 *     found as the narrowest connected piece;
 *   - a thin stroke inside an otherwise healthy shape (a hairline serif),
 *     found by opening the mask and seeing how much ink does not come back.
 *
 * minWidthMm is the narrowest feature worth printing, in millimetres.
 */
export function inspectMask(mask, minWidthMm) {
  const { data, w, h, pxPerMm } = mask;
  const n = w * h;

  const ink = new Uint8Array(n);
  let inkCount = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] >= 0.5) { ink[i] = 1; inkCount++; }
  }
  if (!inkCount) return null;

  const d = distanceToZero(ink, w, h);
  const r = (minWidthMm / 2) * pxPerMm;

  // Smallest complete element: within each connected piece the widest point is
  // its maximum distance, so twice that is how wide the piece ever gets.
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let smallestHalf = Infinity;

  for (let s = 0; s < n; s++) {
    if (!ink[s] || seen[s]) continue;
    let top = 0, area = 0, maxD = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      area++;
      if (d[i] > maxD) maxD = d[i];
      const x = i % w, y = (i - x) / w;
      if (x > 0 && ink[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && ink[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && ink[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && ink[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    // Ignore specks a few pixels across: they are rasteriser noise, not design.
    if (area > 4 && maxD < smallestHalf) smallestHalf = maxD;
  }

  // Opening: keep only what a disc of radius r can reach while staying inside
  // the ink. Whatever does not come back was thinner than minWidthMm.
  const notCore = new Uint8Array(n);
  for (let i = 0; i < n; i++) notCore[i] = d[i] >= r ? 0 : 1;
  const fromCore = distanceToZero(notCore, w, h);

  const thin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (ink[i] && fromCore[i] > r) thin[i] = 1;
  }

  // An opening rounds convex corners, so every shape sheds a little ink at its
  // corners however healthy it is — a clean 1.5 mm bar loses about half a
  // percent that way. Those crumbs are a fraction of a square millimetre each,
  // while a hairline stroke is one long connected run. Counting only runs
  // above a real area separates the two instead of tuning a threshold until
  // the fixtures happen to pass.
  const minRun = 2 * (minWidthMm * pxPerMm) * (minWidthMm * pxPerMm);
  seen.fill(0);
  let thinPixels = 0;

  for (let s = 0; s < n; s++) {
    if (!thin[s] || seen[s]) continue;
    let top = 0, area = 0;
    const members = [];
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      area++;
      members.push(i);
      const x = i % w, y = (i - x) / w;
      if (x > 0 && thin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && thin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && thin[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && thin[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (area >= minRun) thinPixels += area;
  }

  const perMm2 = pxPerMm * pxPerMm;
  return {
    minFeatureMm: Number.isFinite(smallestHalf) ? (smallestHalf * 2) / pxPerMm : Infinity,
    thinFraction: thinPixels / inkCount,
    thinAreaMm2: thinPixels / perMm2,
    inkAreaMm2: inkCount / perMm2,
  };
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

  return {
    data: gray, w, h, pxPerMm, canvas,
    faceW, faceH,
    sat: buildSAT(gray, w, h),
  };
}

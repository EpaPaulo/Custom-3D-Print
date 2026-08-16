// Parametric cover geometry.
//
// The cover is built as a closed (watertight) triangle soup so it can be written
// straight out as an STL. The stamped face is a boundary-conforming Coons grid
// over a rounded rectangle; every vertex is pushed along Z by the stamp mask.
// Walls are sewn to the *displaced* boundary ring, so a design may run all the
// way to the edge without opening a crack in the mesh.

const TAU = Math.PI * 2;

const LINE = 0;
const ARC = 1;

// ---------------------------------------------------------------------------
// Rounded rectangle, parameterised by arc length
// ---------------------------------------------------------------------------

function makeRR(w, h, r) {
  const hw = w / 2;
  const hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));

  const sw = Math.max(0, w - 2 * r);
  const sh = Math.max(0, h - 2 * r);
  const arc = (Math.PI * r) / 2;

  const pieces = [
    { t: LINE, len: sh, x0: hw, y0: -hh + r, x1: hw, y1: hh - r },
    { t: ARC, len: arc, cx: hw - r, cy: hh - r, a0: 0, a1: Math.PI / 2, r },
    { t: LINE, len: sw, x0: hw - r, y0: hh, x1: -hw + r, y1: hh },
    { t: ARC, len: arc, cx: -hw + r, cy: hh - r, a0: Math.PI / 2, a1: Math.PI, r },
    { t: LINE, len: sh, x0: -hw, y0: hh - r, x1: -hw, y1: -hh + r },
    { t: ARC, len: arc, cx: -hw + r, cy: -hh + r, a0: Math.PI, a1: (3 * Math.PI) / 2, r },
    { t: LINE, len: sw, x0: -hw + r, y0: -hh, x1: hw - r, y1: -hh },
    { t: ARC, len: arc, cx: hw - r, cy: -hh + r, a0: (3 * Math.PI) / 2, a1: TAU, r },
  ];

  let total = 0;
  for (const p of pieces) {
    p.s0 = total;
    total += p.len;
  }

  // Arc-length of the midpoint of each corner arc. These four points split the
  // perimeter into the four boundary curves the Coons patch needs.
  return {
    pieces,
    total,
    hw,
    hh,
    r,
    sTR: pieces[1].s0 + arc / 2,
    sTL: pieces[3].s0 + arc / 2,
    sBL: pieces[5].s0 + arc / 2,
    sBR: pieces[7].s0 + arc / 2,
  };
}

function ptAt(rr, s, out) {
  const P = rr.total;
  if (P <= 1e-9) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  s = ((s % P) + P) % P;

  const pieces = rr.pieces;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (s <= p.s0 + p.len + 1e-9) {
      const t = p.len > 1e-12 ? (s - p.s0) / p.len : 0;
      if (p.t === LINE) {
        out[0] = p.x0 + (p.x1 - p.x0) * t;
        out[1] = p.y0 + (p.y1 - p.y0) * t;
      } else {
        const ang = p.a0 + (p.a1 - p.a0) * t;
        out[0] = p.cx + Math.cos(ang) * p.r;
        out[1] = p.cy + Math.sin(ang) * p.r;
      }
      return out;
    }
  }

  const p = pieces[pieces.length - 1];
  if (p.t === LINE) {
    out[0] = p.x1;
    out[1] = p.y1;
  } else {
    out[0] = p.cx + Math.cos(p.a1) * p.r;
    out[1] = p.cy + Math.sin(p.a1) * p.r;
  }
  return out;
}

// The four boundary curves, oriented for a Coons patch:
//   Cb: P00 -> P10   (bottom edge, left to right)
//   Ct: P01 -> P11   (top edge, left to right)
//   Cl: P00 -> P01   (left edge, bottom to top)
//   Cr: P10 -> P11   (right edge, bottom to top)
function boundaryCurves(rr, nu, nv) {
  const P = rr.total;
  const tmp = [0, 0];

  const Cb = new Float64Array((nu + 1) * 2);
  const Ct = new Float64Array((nu + 1) * 2);
  const Cl = new Float64Array((nv + 1) * 2);
  const Cr = new Float64Array((nv + 1) * 2);

  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    ptAt(rr, rr.sBL + (rr.sBR - rr.sBL) * u, tmp);
    Cb[i * 2] = tmp[0];
    Cb[i * 2 + 1] = tmp[1];
    // Top edge runs backwards along the perimeter (sTL down to sTR).
    ptAt(rr, rr.sTL + (rr.sTR - rr.sTL) * u, tmp);
    Ct[i * 2] = tmp[0];
    Ct[i * 2 + 1] = tmp[1];
  }

  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    ptAt(rr, rr.sBL + (rr.sTL - rr.sBL) * v, tmp);
    Cl[j * 2] = tmp[0];
    Cl[j * 2 + 1] = tmp[1];
    // Right edge wraps past s = 0.
    ptAt(rr, rr.sBR + (rr.sTR + P - rr.sBR) * v, tmp);
    Cr[j * 2] = tmp[0];
    Cr[j * 2 + 1] = tmp[1];
  }

  return { Cb, Ct, Cl, Cr };
}

// Coons patch: a quad grid whose boundary is exactly the rounded rectangle.
function coonsGrid(rr, nu, nv) {
  const { Cb, Ct, Cl, Cr } = boundaryCurves(rr, nu, nv);

  const p00x = Cb[0], p00y = Cb[1];
  const p10x = Cb[nu * 2], p10y = Cb[nu * 2 + 1];
  const p01x = Ct[0], p01y = Ct[1];
  const p11x = Ct[nu * 2], p11y = Ct[nu * 2 + 1];

  const gx = new Float64Array((nu + 1) * (nv + 1));
  const gy = new Float64Array((nu + 1) * (nv + 1));

  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    const clx = Cl[j * 2], cly = Cl[j * 2 + 1];
    const crx = Cr[j * 2], cry = Cr[j * 2 + 1];
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const cbx = Cb[i * 2], cby = Cb[i * 2 + 1];
      const ctx = Ct[i * 2], cty = Ct[i * 2 + 1];

      const k = j * (nu + 1) + i;
      gx[k] =
        (1 - v) * cbx + v * ctx + (1 - u) * clx + u * crx -
        ((1 - u) * (1 - v) * p00x + u * (1 - v) * p10x + (1 - u) * v * p01x + u * v * p11x);
      gy[k] =
        (1 - v) * cby + v * cty + (1 - u) * cly + u * cry -
        ((1 - u) * (1 - v) * p00y + u * (1 - v) * p10y + (1 - u) * v * p01y + u * v * p11y);
    }
  }

  return { gx, gy, nu, nv };
}

// Ordered CCW boundary loop of the grid, as grid indices.
// Order matches walking: bottom row -> right column -> top row -> left column.
function ringIndices(nu, nv) {
  const idx = new Int32Array(2 * nu + 2 * nv);
  const W = nu + 1;
  let n = 0;
  for (let i = 0; i <= nu; i++) idx[n++] = 0 * W + i;
  for (let j = 1; j <= nv; j++) idx[n++] = j * W + nu;
  for (let i = nu - 1; i >= 0; i--) idx[n++] = nv * W + i;
  for (let j = nv - 1; j >= 1; j--) idx[n++] = j * W + 0;
  return idx;
}

// Rounded-rect ring with the same point count and ordering as the grid boundary.
function ringOf(w, h, r, nu, nv) {
  const rr = makeRR(w, h, r);
  const { Cb, Ct, Cl, Cr } = boundaryCurves(rr, nu, nv);
  const N = 2 * nu + 2 * nv;
  const ring = new Float64Array(N * 2);
  let n = 0;
  for (let i = 0; i <= nu; i++) {
    ring[n * 2] = Cb[i * 2];
    ring[n * 2 + 1] = Cb[i * 2 + 1];
    n++;
  }
  for (let j = 1; j <= nv; j++) {
    ring[n * 2] = Cr[j * 2];
    ring[n * 2 + 1] = Cr[j * 2 + 1];
    n++;
  }
  for (let i = nu - 1; i >= 0; i--) {
    ring[n * 2] = Ct[i * 2];
    ring[n * 2 + 1] = Ct[i * 2 + 1];
    n++;
  }
  for (let j = nv - 1; j >= 1; j--) {
    ring[n * 2] = Cl[j * 2];
    ring[n * 2 + 1] = Cl[j * 2 + 1];
    n++;
  }
  return ring;
}

// ---------------------------------------------------------------------------
// Summed-area table, for box-filtered sampling of the stamp mask
// ---------------------------------------------------------------------------

export function buildSAT(gray, w, h) {
  const W1 = w + 1;
  const sat = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const src = y * w;
    const cur = (y + 1) * W1;
    const prev = y * W1;
    for (let x = 0; x < w; x++) {
      rowSum += gray[src + x];
      sat[cur + x + 1] = sat[prev + x + 1] + rowSum;
    }
  }
  return sat;
}

function sampleBox(sat, w, h, cx, cy, half) {
  let x0 = Math.floor(cx - half);
  let x1 = Math.ceil(cx + half);
  let y0 = Math.floor(cy - half);
  let y1 = Math.ceil(cy + half);
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 > w ? w : x0;
  x1 = x1 < 0 ? 0 : x1 > w ? w : x1;
  y0 = y0 < 0 ? 0 : y0 > h ? h : y0;
  y1 = y1 < 0 ? 0 : y1 > h ? h : y1;
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;
  const W1 = w + 1;
  const s =
    sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
  return s / area;
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

class MeshBuilder {
  constructor(triCount) {
    this.pos = new Float32Array(triCount * 9);
    this.amt = new Float32Array(triCount * 3);
    this.n = 0; // triangles written
  }

  tri(ax, ay, az, bx, by, bz, cx, cy, cz, aa, ab, ac) {
    const o = this.n * 9;
    const p = this.pos;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az;
    p[o + 3] = bx; p[o + 4] = by; p[o + 5] = bz;
    p[o + 6] = cx; p[o + 7] = cy; p[o + 8] = cz;
    const q = this.n * 3;
    this.amt[q] = aa; this.amt[q + 1] = ab; this.amt[q + 2] = ac;
    this.n++;
  }

  finish() {
    return {
      positions: this.pos.subarray(0, this.n * 9),
      amounts: this.amt.subarray(0, this.n * 3),
      triangles: this.n,
    };
  }
}

/**
 * Build the cover.
 *
 * opts:
 *   width, height      outer size in mm
 *   radius             corner radius in mm
 *   wall               wall / plate thickness in mm
 *   depth              shell depth in mm (shell style only)
 *   style              'shell' | 'plate'
 *   stampDepth         mm, always positive
 *   stampMode          'raised' | 'engraved'
 *   cell               target grid cell size in mm
 *   mask               { data: Float32Array (0..1), w, h, pxPerMm } or null
 */
export function buildCover(opts) {
  const {
    width, height, radius, wall, depth, style,
    stampDepth, stampMode, cell, mask,
  } = opts;

  const isShell = style === 'shell';
  const topZ = isShell ? depth : wall;

  const nu = Math.max(8, Math.round(width / cell));
  const nv = Math.max(8, Math.round(height / cell));
  const W = nu + 1;
  const N = 2 * nu + 2 * nv;

  const rr = makeRR(width, height, radius);
  const { gx, gy } = coonsGrid(rr, nu, nv);

  // --- displacement ------------------------------------------------------
  const nVerts = (nu + 1) * (nv + 1);
  const gz = new Float64Array(nVerts);
  const ga = new Float32Array(nVerts);

  if (mask && stampDepth > 0) {
    const sat = mask.sat;
    const sign = stampMode === 'engraved' ? -1 : 1;
    const halfPx = (cell * mask.pxPerMm) / 2;
    const hw = width / 2;
    const hh = height / 2;
    for (let k = 0; k < nVerts; k++) {
      const px = (gx[k] + hw) * mask.pxPerMm;
      const py = (hh - gy[k]) * mask.pxPerMm; // canvas Y grows downward
      const a = sampleBox(sat, mask.w, mask.h, px, py, halfPx);
      ga[k] = a;
      gz[k] = topZ + sign * stampDepth * a;
    }
  } else {
    for (let k = 0; k < nVerts; k++) gz[k] = topZ;
  }

  // --- triangle budget ---------------------------------------------------
  const topTris = nu * nv * 2;
  const triCount = isShell ? topTris + N * 7 : topTris + N * 3;
  const mb = new MeshBuilder(triCount);

  // --- stamped top face (normal +Z) --------------------------------------
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k00 = j * W + i;
      const k10 = k00 + 1;
      const k01 = k00 + W;
      const k11 = k01 + 1;
      mb.tri(
        gx[k00], gy[k00], gz[k00],
        gx[k10], gy[k10], gz[k10],
        gx[k11], gy[k11], gz[k11],
        ga[k00], ga[k10], ga[k11],
      );
      mb.tri(
        gx[k00], gy[k00], gz[k00],
        gx[k11], gy[k11], gz[k11],
        gx[k01], gy[k01], gz[k01],
        ga[k00], ga[k11], ga[k01],
      );
    }
  }

  // --- outer wall, sewn to the displaced boundary ring -------------------
  const ring = ringIndices(nu, nv);
  for (let k = 0; k < N; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % N];
    const ax = gx[a], ay = gy[a], az = gz[a];
    const bx = gx[b], by = gy[b], bz = gz[b];
    // (T_k, B_k, B_k+1) and (T_k, B_k+1, T_k+1) -> outward normal
    mb.tri(ax, ay, az, ax, ay, 0, bx, by, 0, ga[a], 0, 0);
    mb.tri(ax, ay, az, bx, by, 0, bx, by, bz, ga[a], 0, ga[b]);
  }

  if (isShell) {
    const innerR = Math.max(0, radius - wall);
    const inner = ringOf(
      Math.max(1, width - 2 * wall),
      Math.max(1, height - 2 * wall),
      innerR, nu, nv,
    );
    const innerZ = depth - wall;

    // Rim at z = 0, joining outer ring to inner ring (normal -Z).
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const ox = gx[ring[k]], oy = gy[ring[k]];
      const ox2 = gx[ring[k2]], oy2 = gy[ring[k2]];
      const ix = inner[k * 2], iy = inner[k * 2 + 1];
      const ix2 = inner[k2 * 2], iy2 = inner[k2 * 2 + 1];
      mb.tri(ox, oy, 0, ix, iy, 0, ix2, iy2, 0, 0, 0, 0);
      mb.tri(ox, oy, 0, ix2, iy2, 0, ox2, oy2, 0, 0, 0, 0);
    }

    // Inner wall, z = 0 up to z = innerZ (normal points into the cavity).
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const ix = inner[k * 2], iy = inner[k * 2 + 1];
      const ix2 = inner[k2 * 2], iy2 = inner[k2 * 2 + 1];
      mb.tri(ix, iy, innerZ, ix2, iy2, 0, ix, iy, 0, 0, 0, 0);
      mb.tri(ix, iy, innerZ, ix2, iy2, innerZ, ix2, iy2, 0, 0, 0, 0);
    }

    // Inner ceiling: centroid fan, normal -Z.
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      mb.tri(
        0, 0, innerZ,
        inner[k2 * 2], inner[k2 * 2 + 1], innerZ,
        inner[k * 2], inner[k * 2 + 1], innerZ,
        0, 0, 0,
      );
    }
  } else {
    // Solid plate: flat bottom at z = 0, centroid fan, normal -Z.
    for (let k = 0; k < N; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % N];
      mb.tri(0, 0, 0, gx[b], gy[b], 0, gx[a], gy[a], 0, 0, 0, 0);
    }
  }

  return mb.finish();
}

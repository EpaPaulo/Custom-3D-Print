// Template cover: stamping onto a fixed, supplied STL.
//
// The template's dimensions are the whole point of it, so its triangles are
// never touched. The stamp is emitted as a *separate closed solid* that
// overlaps the cover slightly; the slicer unions the two on import. That keeps
// the base mesh byte-identical to the file that was measured against the
// machine, and it sidesteps CSG entirely.

// How far the un-inked parts of the slab sit inside the face. Buried either
// way, so the printed result is unaffected, but it needs to be comfortably
// more than the depth buffer can resolve or the preview z-fights.
const EPS = 0.15;
const EMBED = 0.6;  // how deep the slab is buried, to guarantee a clean union

// ---------------------------------------------------------------------------
// Binary STL
// ---------------------------------------------------------------------------

export function parseSTL(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const count = dv.getUint32(80, true);
  if (84 + count * 50 !== arrayBuffer.byteLength) {
    throw new Error('Not a binary STL, or the file is truncated.');
  }
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    for (let i = 0; i < 3; i++) {
      positions[t * 9 + i * 3] = dv.getFloat32(o + 12 + i * 12, true);
      positions[t * 9 + i * 3 + 1] = dv.getFloat32(o + 16 + i * 12, true);
      positions[t * 9 + i * 3 + 2] = dv.getFloat32(o + 20 + i * 12, true);
    }
  }
  return { positions, triangles: count, source: arrayBuffer };
}

/**
 * Locate the flat outward face to stamp on: the lowest Z plane carrying
 * downward-facing triangles. Returns its plane, outline box and centre, plus
 * the largest axis-aligned rectangle that stays clear of the rounded corners.
 */
export function analyseFace(positions) {
  const tri = positions.length / 9;

  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    if (positions[i] < minZ) minZ = positions[i];
  }

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let area = 0;
  // Straight runs along each side reveal the corner radius.
  let leftLo = Infinity, leftHi = -Infinity, botLo = Infinity, botHi = -Infinity;

  for (let t = 0; t < tri; t++) {
    const o = t * 9;
    if (Math.abs(positions[o + 2] - minZ) > 1e-4 ||
        Math.abs(positions[o + 5] - minZ) > 1e-4 ||
        Math.abs(positions[o + 8] - minZ) > 1e-4) continue;

    const cz = (positions[o + 3] - positions[o]) * (positions[o + 7] - positions[o + 1]) -
               (positions[o + 4] - positions[o + 1]) * (positions[o + 6] - positions[o]);
    if (cz >= 0) continue; // keep only downward-facing
    area += Math.abs(cz) / 2;

    for (let i = 0; i < 3; i++) {
      const px = positions[o + i * 3];
      const py = positions[o + i * 3 + 1];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }

  for (let t = 0; t < tri; t++) {
    const o = t * 9;
    if (Math.abs(positions[o + 2] - minZ) > 1e-4) continue;
    for (let i = 0; i < 3; i++) {
      const px = positions[o + i * 3];
      const py = positions[o + i * 3 + 1];
      if (Math.abs(px - x0) < 1e-4) { leftLo = Math.min(leftLo, py); leftHi = Math.max(leftHi, py); }
      if (Math.abs(py - y0) < 1e-4) { botLo = Math.min(botLo, px); botHi = Math.max(botHi, px); }
    }
  }

  const rY = Number.isFinite(leftLo) ? leftLo - y0 : 0;
  const rX = Number.isFinite(botLo) ? botLo - x0 : 0;
  const radius = Math.max(0, Math.min(rX, rY));

  // A rectangle inscribed in a rounded rectangle must pull in by r(1 - 1/√2)
  // at each side to clear the arcs. A little extra keeps designs off the edge.
  const inset = radius * (1 - Math.SQRT1_2) + 2;

  return {
    z: minZ,
    width: x1 - x0,
    height: y1 - y0,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    radius,
    area,
    safeWidth: Math.max(10, x1 - x0 - 2 * inset),
    safeHeight: Math.max(10, y1 - y0 - 2 * inset),
  };
}

// ---------------------------------------------------------------------------
// Stamp slab
// ---------------------------------------------------------------------------

function sampleBox(sat, w, h, cx, cy, half) {
  let ax = Math.floor(cx - half), bx = Math.ceil(cx + half);
  let ay = Math.floor(cy - half), by = Math.ceil(cy + half);
  if (bx <= ax) bx = ax + 1;
  if (by <= ay) by = ay + 1;
  ax = ax < 0 ? 0 : ax > w ? w : ax;
  bx = bx < 0 ? 0 : bx > w ? w : bx;
  ay = ay < 0 ? 0 : ay > h ? h : ay;
  by = by < 0 ? 0 : by > h ? h : by;
  const n = (bx - ax) * (by - ay);
  if (n <= 0) return 0;
  const W1 = w + 1;
  return (sat[by * W1 + bx] - sat[ay * W1 + bx] - sat[by * W1 + ax] + sat[ay * W1 + ax]) / n;
}

/**
 * Build the raised design as one closed solid sitting on the template's face.
 *
 * Layer coordinates are the face as the user sees it (looking at the outward
 * side, +x right, +y up). The face normal points along -Z, so a viewer looking
 * at it sees world +X reversed — hence the mirror when mapping to world space.
 *
 * face   result of analyseFace
 * mask   { sat, w, h, pxPerMm } over the full safe area, or null
 * height how far the design stands proud of the face, in mm
 * cell   grid pitch in mm
 */
export function buildStampSolid(face, mask, height, cell) {
  if (!mask || height <= 0) return new Float32Array(0);

  // Only tessellate where the design actually is.
  const box = maskExtent(mask);
  if (!box) return new Float32Array(0);

  const pad = 1.5;
  const lx0 = Math.max(-face.safeWidth / 2, box.x0 - pad);
  const lx1 = Math.min(face.safeWidth / 2, box.x1 + pad);
  const ly0 = Math.max(-face.safeHeight / 2, box.y0 - pad);
  const ly1 = Math.min(face.safeHeight / 2, box.y1 + pad);
  if (lx1 - lx0 < 0.5 || ly1 - ly0 < 0.5) return new Float32Array(0);

  const nu = Math.max(4, Math.round((lx1 - lx0) / cell));
  const nv = Math.max(4, Math.round((ly1 - ly0) / cell));
  const W = nu + 1;

  const LX = (i) => lx0 + ((lx1 - lx0) * i) / nu;
  const LY = (j) => ly0 + ((ly1 - ly0) * j) / nv;

  const outerZ = new Float64Array((nu + 1) * (nv + 1));
  const halfPx = (cell * mask.pxPerMm) / 2;

  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const px = (LX(i) + face.safeWidth / 2) * mask.pxPerMm;
      const py = (face.safeHeight / 2 - LY(j)) * mask.pxPerMm;
      const a = sampleBox(mask.sat, mask.w, mask.h, px, py, halfPx);
      // a = 0 -> just inside the face; a = 1 -> standing proud by `height`
      outerZ[j * W + i] = face.z + EPS - (height + EPS) * a;
    }
  }

  const innerZ = face.z + EMBED;
  const N = 2 * nu + 2 * nv;
  const pos = new Float32Array((nu * nv * 4 + N * 2) * 9);
  let n = 0;

  // Triangles are reasoned about in layer space (x right, y up, z as in world).
  // Mapping to world mirrors X, and a reflection reverses winding, so each
  // triangle is written with its last two vertices swapped — that keeps a
  // layer-space outward face outward once mirrored.
  const emit = (a, b, c) => {
    const o = n * 9;
    const w = (p, k) => {
      pos[o + k] = face.cx - p[0];
      pos[o + k + 1] = face.cy + p[1];
      pos[o + k + 2] = p[2];
    };
    w(a, 0); w(c, 3); w(b, 6);
    n++;
  };

  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const xa = LX(i), xb = LX(i + 1);
      const ya = LY(j), yb = LY(j + 1);

      // Outward surface of the stamp: faces -Z, so clockwise in layer space.
      const A = [xa, ya, outerZ[j * W + i]];
      const B = [xb, ya, outerZ[j * W + i + 1]];
      const C = [xb, yb, outerZ[(j + 1) * W + i + 1]];
      const D = [xa, yb, outerZ[(j + 1) * W + i]];
      emit(A, C, B);
      emit(A, D, C);

      // Buried surface: faces +Z, so counter-clockwise.
      const a2 = [xa, ya, innerZ];
      const b2 = [xb, ya, innerZ];
      const c2 = [xb, yb, innerZ];
      const d2 = [xa, yb, innerZ];
      emit(a2, b2, c2);
      emit(a2, c2, d2);
    }
  }

  // Side walls, joining the buried surface down to the outward one.
  const ring = [];
  for (let i = 0; i <= nu; i++) ring.push([i, 0]);
  for (let j = 1; j <= nv; j++) ring.push([nu, j]);
  for (let i = nu - 1; i >= 0; i--) ring.push([i, nv]);
  for (let j = nv - 1; j >= 1; j--) ring.push([0, j]);

  for (let k = 0; k < ring.length; k++) {
    const [i1, j1] = ring[k];
    const [i2, j2] = ring[(k + 1) % ring.length];
    const T1 = [LX(i1), LY(j1), innerZ];
    const T2 = [LX(i2), LY(j2), innerZ];
    const B1 = [LX(i1), LY(j1), outerZ[j1 * W + i1]];
    const B2 = [LX(i2), LY(j2), outerZ[j2 * W + i2]];
    emit(T1, B1, B2);
    emit(T1, B2, T2);
  }

  return pos.subarray(0, n * 9);
}

// Bounding box of the inked part of the mask, in layer millimetres.
function maskExtent(mask) {
  const { data, w, h, pxPerMm } = mask;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] > 0.02) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return {
    x0: x0 / pxPerMm - mask.faceW / 2,
    x1: x1 / pxPerMm - mask.faceW / 2,
    y0: mask.faceH / 2 - y1 / pxPerMm,
    y1: mask.faceH / 2 - y0 / pxPerMm,
  };
}

/**
 * Write the export: the template's own 50-byte records copied through
 * untouched, then the design appended as a second body.
 *
 * Copying raw bytes rather than re-encoding means the supplied mesh survives
 * exactly — same vertices, same stored normals, same triangle count, including
 * the handful of degenerate faces the file already contains. Re-encoding would
 * silently drop those and renormalise the rest.
 */
export function buildExportSTL(source, sourceCount, slab, header = 'cover') {
  const slabTris = slab ? slab.length / 9 : 0;
  const total = sourceCount + slabTris;

  const out = new ArrayBuffer(84 + total * 50);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);

  const head = String(header).slice(0, 79);
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i) & 0x7f;
  view.setUint32(80, total, true);

  bytes.set(new Uint8Array(source, 84, sourceCount * 50), 84);

  let off = 84 + sourceCount * 50;
  for (let t = 0; t < slabTris; t++) {
    const o = t * 9;
    const ax = slab[o], ay = slab[o + 1], az = slab[o + 2];
    const bx = slab[o + 3], by = slab[o + 4], bz = slab[o + 5];
    const cx = slab[o + 6], cy = slab[o + 7], cz = slab[o + 8];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }

    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    const v = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let i = 0; i < 9; i++) view.setFloat32(off + 12 + i * 4, v[i], true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }

  return { buffer: out, triangles: total };
}

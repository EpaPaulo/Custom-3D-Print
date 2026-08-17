// Template cover: two-colour design on a fixed, supplied STL.
//
// The cover prints black and the design prints white, flush with the surface —
// there is no relief. So the design is not a stamp standing proud of the face;
// it is an *inlay* occupying the first few layers of the cover, emitted as its
// own closed solid in the same coordinate space. The slicer loads the two as
// parts of one object and assigns a filament to each.
//
// The template's dimensions are the whole point of it, so its triangles are
// never touched, and the inlay never crosses the face plane outward.

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
// Design inlay
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
 * Build the design as a closed solid inlaid into the cover's outward face.
 *
 * The surface of the inlay sits exactly on the face plane and the body extends
 * inward, so the printed part has no relief: the colour change happens in the
 * first few layers and the two filaments meet flush.
 *
 * Geometry comes from marching *triangles* rather than marching squares. The
 * square case has an ambiguous saddle whose two readings differ, and the wrong
 * reading joins letterforms that should stay apart; splitting each cell into
 * two triangles removes the ambiguity entirely, and every region it produces is
 * convex, so a fan triangulation of it is always valid.
 *
 * surface   { z, cx, cy, dir, mirror } — the face plane, the centre of the
 *           design area in world XY, +1/-1 for which way the face points, and
 *           whether layer +x maps to world -x.
 * mask      { sat, w, h, pxPerMm, faceW, faceH } over the usable area, or null
 * thickness how deep the colour runs into the cover, in mm
 * cell      grid pitch in mm
 */
export function buildInlaySolid(surface, mask, thickness, cell) {
  if (!mask || thickness <= 0) return new Float32Array(0);

  const box = maskExtent(mask);
  if (!box) return new Float32Array(0);

  // Two cells of margin so the field reaches zero before the grid ends, which
  // is what closes the contour.
  const pad = cell * 2;
  const lx0 = box.x0 - pad, lx1 = box.x1 + pad;
  const ly0 = box.y0 - pad, ly1 = box.y1 + pad;

  const nu = Math.max(2, Math.ceil((lx1 - lx0) / cell));
  const nv = Math.max(2, Math.ceil((ly1 - ly0) / cell));
  const W = nu + 1;
  const LX = (i) => lx0 + ((lx1 - lx0) * i) / nu;
  const LY = (j) => ly0 + ((ly1 - ly0) * j) / nv;

  // Sample the mask onto the grid. Anything beyond the usable area is forced
  // to zero: sampleBox clamps to the bitmap, which would otherwise smear the
  // edge value outward and leave the contour open.
  const field = new Float32Array((nu + 1) * (nv + 1));
  const halfPx = (cell * mask.pxPerMm) / 2;
  const hw = mask.faceW / 2;
  const hh = mask.faceH / 2;

  for (let j = 0; j <= nv; j++) {
    const ly = LY(j);
    for (let i = 0; i <= nu; i++) {
      const lx = LX(i);
      if (lx <= -hw || lx >= hw || ly <= -hh || ly >= hh) continue;
      field[j * W + i] = sampleBox(
        mask.sat, mask.w, mask.h,
        (lx + hw) * mask.pxPerMm, (hh - ly) * mask.pxPerMm, halfPx,
      );
    }
  }

  const ISO = 0.5;
  const zSurface = surface.z;
  const zInner = surface.z - surface.dir * thickness;
  const zHi = Math.max(zSurface, zInner);
  const zLo = Math.min(zSurface, zInner);

  let capacity = 8192;
  let pos = new Float32Array(capacity * 9);
  let n = 0;

  const put = (p, o, k) => {
    pos[o + k] = surface.mirror ? surface.cx - p[0] : surface.cx + p[0];
    pos[o + k + 1] = surface.cy + p[1];
    pos[o + k + 2] = p[2];
  };

  // Triangles are reasoned about in layer space, where +x is right and +y is
  // up as the design is seen. Mirroring reverses winding, so the last two
  // vertices swap on the way out.
  function emit(a, b, c) {
    // Where a sample lands exactly on the threshold, a crossing point can
    // coincide with the corner it came from, collapsing a wall to nothing.
    // Such a face has no surface but its edges are real, and they duplicate a
    // neighbour's — which is what makes a shape like a checkerboard, whose
    // squares touch at a point, come out non-manifold. Dropping them here
    // costs nothing: a zero-area face encloses no volume.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;

    if (n >= capacity) {
      capacity *= 2;
      const bigger = new Float32Array(capacity * 9);
      bigger.set(pos);
      pos = bigger;
    }
    const o = n * 9;
    put(a, o, 0);
    if (surface.mirror) { put(c, o, 3); put(b, o, 6); } else { put(b, o, 3); put(c, o, 6); }
    n++;
  }

  // The part of one triangle where the field is at or above the threshold.
  // Points landing on an edge crossing are flagged, because only a run between
  // two crossings is real contour — the rest lies on a shared cell edge and is
  // covered by the neighbouring cell.
  const region = [];
  function regionOf(t) {
    region.length = 0;
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const ain = a[2] >= ISO;
      const bin = b[2] >= ISO;
      if (ain) region.push(a[0], a[1], 0);
      if (ain !== bin) {
        const f = (ISO - a[2]) / (b[2] - a[2]);
        region.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 1);
      }
    }
    return region.length / 3;
  }

  const corner = (i, j) => [LX(i), LY(j), field[j * W + i]];
  const px = (k) => region[k * 3];
  const py = (k) => region[k * 3 + 1];
  const isCross = (k) => region[k * 3 + 2] === 1;

  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const c00 = corner(i, j);
      const c10 = corner(i + 1, j);
      const c11 = corner(i + 1, j + 1);
      const c01 = corner(i, j + 1);

      for (const t of [[c00, c10, c11], [c00, c11, c01]]) {
        const count = regionOf(t);
        if (count < 3) continue;

        // Caps. The region is convex and wound counter-clockwise, so a fan
        // from its first vertex covers it exactly.
        for (let k = 1; k + 1 < count; k++) {
          emit([px(0), py(0), zHi], [px(k), py(k), zHi], [px(k + 1), py(k + 1), zHi]);
          emit([px(0), py(0), zLo], [px(k + 1), py(k + 1), zLo], [px(k), py(k), zLo]);
        }

        // Walls, only along the contour itself.
        for (let k = 0; k < count; k++) {
          const m = (k + 1) % count;
          if (!isCross(k) || !isCross(m)) continue;
          const ax = px(k), ay = py(k), bx = px(m), by = py(m);
          emit([ax, ay, zHi], [ax, ay, zLo], [bx, by, zLo]);
          emit([ax, ay, zHi], [bx, by, zLo], [bx, by, zHi]);
        }
      }
    }
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

// Plate outlines, and which stud positions survive them.
//
// Every shape is produced as a single closed polygon in millimetres, wound
// counter-clockwise, centred on the origin and fitted to the plate's bounding
// box. Keeping the outline analytic — rather than snapping it to the stud grid
// — is what lets a round plate come out actually round instead of stepped; the
// studs are then filtered against the outline afterwards, so a stud only exists
// where there is plate under all of it.

const TAU = Math.PI * 2;

/**
 * The shapes on offer, and which of the shape parameters each one reads. The
 * UI builds its controls from this list and the backend validates against it,
 * so a shape is added in exactly one place.
 */
export const SHAPES = [
  { id: 'rect', label: 'Retângulo', params: ['corner'] },
  { id: 'ellipse', label: 'Círculo / elipse', params: [] },
  { id: 'polygon', label: 'Polígono regular', params: ['sides', 'rotation'] },
  { id: 'star', label: 'Estrela', params: ['points', 'innerRatio', 'rotation'] },
  { id: 'cross', label: 'Cruz', params: ['arm'] },
  { id: 'lshape', label: 'Forma em L', params: ['armX', 'armY'] },
  { id: 'heart', label: 'Coração', params: [] },
];

export const shapeById = (id) => SHAPES.find((s) => s.id === id);

/**
 * Outline for a plate.
 *
 * `w` and `h` are the outer footprint in millimetres — already the stud count
 * times the pitch, less the side-by-side clearance. `chord` is the longest
 * straight segment a curve may be approximated by, which is how the quality
 * setting reaches the geometry.
 */
export function buildOutline(spec, w, h, chord = 0.4) {
  switch (spec.shape) {
    case 'ellipse': return ellipse(w, h, chord);
    case 'polygon': return regular(w, h, spec.sides, spec.rotation);
    case 'star': return star(w, h, spec.points, spec.innerRatio, spec.rotation);
    case 'cross': return cross(w, h, spec.arm * spec.pitch);
    case 'lshape': return lshape(w, h, spec.armX * spec.pitch, spec.armY * spec.pitch);
    case 'heart': return heart(w, h, chord);
    case 'rect':
    default: return roundedRect(w, h, spec.corner, chord);
  }
}

// How many segments a curve of the given length needs to stay within `chord`
// of the true curve. Bounded at both ends: too few looks faceted, too many
// costs triangles for detail no printer resolves.
function segmentsFor(length, chord, min = 12, max = 900) {
  return Math.max(min, Math.min(max, Math.ceil(length / Math.max(0.05, chord))));
}

function roundedRect(w, h, r, chord) {
  const hw = w / 2;
  const hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  if (r < 1e-6) return [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];

  const seg = Math.max(3, Math.ceil(segmentsFor((TAU * r) / 4, chord, 3, 200)));
  const pts = [];
  const corners = [
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
    [hw - r, -hh + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return dedupe(pts);
}

function ellipse(w, h, chord) {
  const a = w / 2;
  const b = h / 2;
  // Ramanujan's perimeter approximation is far more accurate than 2*pi*r_mean
  // for the elongated ellipses a non-square stud count produces.
  const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const seg = segmentsFor(per, chord, 24);
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * TAU;
    pts.push([Math.cos(t) * a, Math.sin(t) * b]);
  }
  return pts;
}

// A regular n-gon, then stretched to fill the box. Equal stud counts keep it
// regular; unequal ones give the stretched version the dimensions asked for.
function regular(w, h, n, rotationDeg) {
  n = Math.max(3, Math.min(24, Math.round(n)));
  const rot = ((rotationDeg || 0) * Math.PI) / 180;
  const raw = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    raw.push([Math.cos(a), Math.sin(a)]);
  }
  return fitToBox(raw, w, h);
}

function star(w, h, n, innerRatio, rotationDeg) {
  n = Math.max(3, Math.min(24, Math.round(n)));
  const ratio = Math.max(0.15, Math.min(0.95, innerRatio));
  const rot = ((rotationDeg || 0) * Math.PI) / 180;
  const raw = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i / (n * 2)) * TAU;
    const r = i % 2 === 0 ? 1 : ratio;
    raw.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return fitToBox(raw, w, h);
}

function cross(w, h, arm) {
  const hw = w / 2;
  const hh = h / 2;
  const a = Math.max(1, Math.min(arm, w, h)) / 2;
  return [
    [a, -hh], [a, -a], [hw, -a], [hw, a], [a, a], [a, hh],
    [-a, hh], [-a, a], [-hw, a], [-hw, -a], [-a, -a], [-a, -hh],
  ];
}

// An L standing on its foot: the full width along the bottom, the leg rising
// on the left. `ax` is the leg width, `ay` the foot height.
function lshape(w, h, ax, ay) {
  const hw = w / 2;
  const hh = h / 2;
  ax = Math.max(1, Math.min(ax, w));
  ay = Math.max(1, Math.min(ay, h));
  return [
    [-hw, -hh], [hw, -hh], [hw, -hh + ay], [-hw + ax, -hh + ay], [-hw + ax, hh], [-hw, hh],
  ];
}

// The classic parametric heart. Its parameter runs far faster along the sides
// than through the bottom cusp, so sampling it evenly in t would crowd hundreds
// of points into a few microns there and leave slivers in the mesh. Sampling it
// densely and then resampling by arc length gives edges of one honest length.
function heart(w, h, chord) {
  const raw = [];
  const dense = 2000;
  for (let i = 0; i < dense; i++) {
    // Walked backwards so the classic parameterisation comes out CCW.
    const t = TAU - (i / dense) * TAU;
    const s = Math.sin(t);
    raw.push([
      16 * s * s * s,
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    ]);
  }
  const fitted = fitToBox(raw, w, h);
  return resampleClosed(fitted, segmentsFor(perimeter(fitted), chord, 60, 900));
}

export function perimeter(pts) {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
  }
  return sum;
}

// Walk a closed polyline at a constant step, so every edge comes out the same
// length no matter how unevenly the source curve was parameterised.
function resampleClosed(pts, n) {
  const total = perimeter(pts);
  if (!(total > 0) || n < 3) return pts;
  const step = total / n;
  const out = [];
  let idx = 0;
  let carried = 0; // distance already walked into the edge starting at idx

  for (let k = 0; k < n; k++) {
    let want = step;
    for (;;) {
      const a = pts[idx];
      const b = pts[(idx + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const left = len - carried;
      if (want <= left || idx === pts.length - 1 && k === n - 1) {
        const t = len > 0 ? (carried + want) / len : 0;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        carried += want;
        break;
      }
      want -= left;
      carried = 0;
      idx = (idx + 1) % pts.length;
    }
  }
  return dedupe(out);
}

// Scale and centre a unit-ish outline so it exactly fills w x h.
function fitToBox(pts, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const sx = (maxX - minX) > 1e-9 ? w / (maxX - minX) : 1;
  const sy = (maxY - minY) > 1e-9 ? h / (maxY - minY) : 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return dedupe(pts.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]));
}

// Coincident neighbours make zero-length wall quads, so drop them here rather
// than leaving every consumer to cope.
function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-7) out.push(p);
  }
  while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-7) {
    out.pop();
  }
  return ensureCCW(out);
}

export function polygonArea(pts) {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += (pts[j][0] * pts[i][1]) - (pts[i][0] * pts[j][1]);
  }
  return sum / 2;
}

function ensureCCW(pts) {
  return polygonArea(pts) < 0 ? pts.slice().reverse() : pts;
}

// ---------------------------------------------------------------------------
// Stud placement
// ---------------------------------------------------------------------------

export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToOutline(pts, x, y) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, y1] = pts[j];
    const [x2, y2] = pts[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (x1 + dx * t), y - (y1 + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Where the studs go.
 *
 * The grid is the same one a real plate uses: `nx` by `ny` positions at the
 * pitch, centred on the footprint, which leaves (pitch - clearance) / 2 between
 * the outermost stud centre and the edge — 3.9 mm at LEGO's dimensions, exactly
 * what the reference baseplate measures. A position is kept only when the whole
 * stud circle, plus `margin`, lies inside the outline, so no stud is ever left
 * hanging over the edge of a round or angled plate.
 *
 * Returns the kept positions along with their grid coordinates, which the
 * patterns need to reason about neighbours.
 */
export function studGrid(outline, { nx, ny, pitch, radius, margin = 0.3, pattern = 'full' }) {
  const need = radius + margin;
  const kept = [];
  const occupied = new Set();

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i - (nx - 1) / 2) * pitch;
      const y = (j - (ny - 1) / 2) * pitch;
      if (!pointInPolygon(outline, x, y)) continue;
      if (distanceToOutline(outline, x, y) < need) continue;
      kept.push({ i, j, x, y });
      occupied.add(`${i},${j}`);
    }
  }

  if (pattern === 'none') return [];
  if (pattern === 'checker') return kept.filter(({ i, j }) => (i + j) % 2 === 0);
  if (pattern === 'border') {
    // A stud is on the border when any of its four neighbours is missing —
    // which follows the real edge of the shape, not the bounding box.
    return kept.filter(({ i, j }) => (
      !occupied.has(`${i - 1},${j}`) || !occupied.has(`${i + 1},${j}`) ||
      !occupied.has(`${i},${j - 1}`) || !occupied.has(`${i},${j + 1}`)
    ));
  }
  return kept;
}

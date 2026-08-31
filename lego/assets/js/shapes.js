// Plate outlines, and which stud positions survive them.
//
// Every shape is produced as a set of closed polygons in millimetres, centred
// on the origin and fitted to the plate's bounding box: one outer ring wound
// counter-clockwise, plus a hole ring wound clockwise for each opening in it.
// Most shapes have no holes at all; letters are what the holes are for, since
// an O without its counter is not an O. Keeping the outline analytic — rather than snapping it to the stud grid
// — is what lets a round plate come out actually round instead of stepped; the
// studs are then filtered against the outline afterwards, so a stud only exists
// where there is plate under all of it.

import { FONTS, CHARACTERS, fontById } from './glyphs.js';

export { FONTS, CHARACTERS, fontById };

const TAU = Math.PI * 2;

/**
 * The shapes on offer, and which of the shape parameters each one reads. The
 * UI builds its controls from this list and the backend validates against it,
 * so a shape is added in exactly one place.
 */
/**
 * The shapes on offer: which of the shape parameters each one reads, and the
 * stud count it looks right at. The UI builds its controls and its icons from
 * this list and the backend validates against it, so a shape is added in
 * exactly one place.
 *
 * `size` matters more for the figures than for the geometric shapes. Every
 * outline is stretched to fill the width and depth asked for, which is the
 * point — you buy a plate in studs, not in proportions — but a candy cane
 * stretched to a square reads as nothing at all. Picking a shape starts you at
 * the proportions it was drawn in; both sliders still do what they say.
 */
export const SHAPES = [
  { id: 'rect', label: 'Retângulo', params: ['corner'], size: [28, 25] },
  { id: 'ellipse', label: 'Círculo / elipse', params: [], size: [20, 20] },
  { id: 'polygon', label: 'Polígono regular', params: ['sides', 'rotation'], size: [20, 20] },
  { id: 'star', label: 'Estrela', params: ['points', 'innerRatio', 'rotation'], size: [24, 24] },
  { id: 'cross', label: 'Cruz', params: ['arm'], size: [15, 15] },
  { id: 'lshape', label: 'Forma em L', params: ['armX', 'armY'], size: [20, 20] },
  { id: 'heart', label: 'Coração', params: [], size: [20, 18] },
  { id: 'santa', label: 'Pai Natal', params: [], size: [22, 24] },
  { id: 'bunny', label: 'Coelho', params: [], size: [18, 26] },
  { id: 'candycane', label: 'Bengala doce', params: [], size: [14, 26] },
  { id: 'pumpkin', label: 'Abóbora', params: [], size: [22, 22] },
  { id: 'ghost', label: 'Fantasma', params: [], size: [20, 24] },
  // The only shape whose width is not the customer's to set: a letter squashed
  // to a width someone picked is a different letter. `depth` is its height, and
  // the width follows from the glyph.
  { id: 'text', label: 'Letra / número', params: ['char', 'font'], size: [12, 20], derivedWidth: true },
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
    case 'text': return glyph(w, h, chord, spec.char, spec.font);
    case 'ellipse': return solid(ellipse(w, h, chord));
    case 'polygon': return solid(regular(w, h, spec.sides, spec.rotation));
    case 'star': return solid(star(w, h, spec.points, spec.innerRatio, spec.rotation));
    // Arms are counted in studs, so they are measured against the *scaled*
    // pitch — the grid the studs actually land on — not the nominal one.
    case 'cross': return solid(cross(w, h, spec.arm * spec.pitch * spec.scale));
    case 'lshape': return solid(lshape(
      w, h, spec.armX * spec.pitch * spec.scale, spec.armY * spec.pitch * spec.scale));
    case 'heart': return solid(heart(w, h, chord));
    case 'santa': return solid(santa(w, h, chord));
    case 'bunny': return solid(bunny(w, h, chord));
    case 'candycane': return solid(candycane(w, h, chord));
    case 'pumpkin': return solid(pumpkin(w, h, chord));
    case 'ghost': return solid(ghost(w, h, chord));
    case 'rect':
    default: return solid(roundedRect(w, h, spec.corner, chord));
  }
}

// A shape with nothing cut out of it, which is all of them but the letters.
const solid = (outer) => ({ outer, holes: [] });

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

// ---------------------------------------------------------------------------
// Letters and numbers
// ---------------------------------------------------------------------------

export class GlyphError extends Error {}

// How finely a quadratic segment is walked before the arc-length resampling
// takes over. Dense rather than accurate: the resampling is what decides the
// mesh's resolution, and this only has to give it a smooth curve to walk.
const QUAD_STEPS = 12;

/**
 * The outline of one character, as an outer ring plus a hole for each counter.
 *
 * The glyph is fitted to the plate's box like any other shape. That is only
 * safe because the caller has already sized the box from the glyph's own
 * proportions — see the derived width in plate.js. Stretch a letter to a width
 * somebody picked off a slider and you get a different letter.
 */
function glyph(w, h, chord, char, fontId) {
  const font = fontById(fontId);
  if (!font) throw new GlyphError(`Unknown font "${String(fontId).slice(0, 24)}".`);
  const g = font.glyphs[char];
  if (!g) throw new GlyphError(`No glyph for "${String(char).slice(0, 4)}".`);

  const contours = g.c.map(quadContour).filter((c) => c.length >= 3);
  if (!contours.length) throw new GlyphError(`"${char}" has no outline.`);

  // A font says which contours are material and which are openings by winding
  // them opposite ways round, so that is what decides here — not which is
  // biggest, which gets a dotted zero wrong. The largest is the letter itself;
  // of the rest, the ones wound against it are its counters.
  const areas = contours.map(polygonArea);
  let outerAt = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[outerAt])) outerAt = i;
  }
  const material = Math.sign(areas[outerAt]);

  // Anything wound the same way as the letter is a separate island of material
  // — the dot inside a monospaced zero, say. A plate is one piece, so an island
  // floating in the middle of a counter cannot be printed and is dropped: the
  // zero comes out undotted rather than in two parts.
  const keep = [contours[outerAt]];
  for (let i = 0; i < contours.length; i++) {
    if (i !== outerAt && Math.sign(areas[i]) !== material) keep.push(contours[i]);
  }

  const rings = fitRingsToBox(keep, w, h);
  const outer = rings[0];
  const holes = rings.slice(1);

  const detail = (ring) => resampleClosed(ring, segmentsFor(perimeter(ring), chord, 40, 900));

  return {
    outer: detail(outer),
    // Holes run the other way round from the outer ring, which is what tells
    // the triangulator and the wall which side the material is on.
    holes: holes.map((ring) => detail(ring).slice().reverse()),
  };
}

// One TrueType contour, flattened. The format leaves the on-curve point between
// two consecutive control points implied, at their midpoint, which is restored
// here before the quadratics are walked.
function quadContour(flat) {
  const n = flat.length / 3;
  if (n < 2) return [];

  const expanded = [];
  for (let i = 0; i < n; i++) {
    const x = flat[i * 3];
    const y = flat[i * 3 + 1];
    const on = flat[i * 3 + 2];
    const j = ((i - 1 + n) % n) * 3;
    if (!on && !flat[j + 2]) expanded.push([(x + flat[j]) / 2, (y + flat[j + 1]) / 2, 1]);
    expanded.push([x, y, on]);
  }

  const start = expanded.findIndex((pt) => pt[2]);
  if (start < 0) return [];

  const order = [];
  for (let i = 0; i < expanded.length; i++) order.push(expanded[(start + i) % expanded.length]);
  order.push(order[0]);

  const pts = [[order[0][0], order[0][1]]];
  let cur = order[0];
  for (let i = 1; i < order.length;) {
    const p = order[i];
    if (p[2]) {
      pts.push([p[0], p[1]]);
      cur = p;
      i += 1;
    } else {
      const next = order[i + 1];
      for (let k = 1; k <= QUAD_STEPS; k++) {
        const t = k / QUAD_STEPS;
        const u = 1 - t;
        pts.push([
          u * u * cur[0] + 2 * u * t * p[0] + t * t * next[0],
          u * u * cur[1] + 2 * u * t * p[1] + t * t * next[1],
        ]);
      }
      cur = next;
      i += 2;
    }
  }
  return pts;
}

/** A glyph's width over its height, which is what decides how wide its plate is. */
export function glyphAspect(fontId, char) {
  const font = fontById(fontId);
  const g = font && font.glyphs[char];
  if (!g) return 1;
  const width = g.b[2] - g.b[0];
  const height = g.b[3] - g.b[1];
  return height > 0 ? width / height : 1;
}

// Every ring scaled and centred by the same transform, so they keep their
// positions relative to each other.
function fitRingsToBox(rings, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const sx = (maxX - minX) > 1e-9 ? w / (maxX - minX) : 1;
  const sy = (maxY - minY) > 1e-9 ? h / (maxY - minY) : 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return rings.map((ring) => dedupe(ring.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy])));
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------
//
// The shapes below are drawings rather than formulas, so they are written the
// way a drawing is: a pen path of straight runs, cubic curves and arcs, in
// whatever coordinates were convenient to draw in. `figure` then scales the
// result into the plate's box, so only the proportions of these numbers matter,
// never their size.
//
// Each is a single closed outline with no holes. That is a constraint, not a
// stylistic choice: the plate is one solid, so a ghost cannot have cut-out eyes
// and a pumpkin cannot have a carved face without the plate falling into
// pieces. What reads as the figure has to be in its silhouette.

const CURVE_STEPS = 24;
const rad = (deg) => (deg * Math.PI) / 180;

// A minimal pen. Everything is flattened to points as it is drawn, densely
// enough that the arc-length resampling in `figure` has something smooth to
// walk along.
function pen() {
  const pts = [];
  let cur = [0, 0];

  const api = {
    move(x, y) {
      cur = [x, y];
      pts.push(cur);
      return api;
    },

    line(x, y) {
      cur = [x, y];
      pts.push(cur);
      return api;
    },

    curve(x1, y1, x2, y2, x, y) {
      const [x0, y0] = cur;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        pts.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        ]);
      }
      cur = [x, y];
      return api;
    },

    // Angles in degrees, and signed: going from 0 to 360 sweeps the other way
    // round from 0 to -360, which is how the two sides of a stroke are drawn.
    arc(cx, cy, r, from, to) {
      const sweep = Math.abs(to - from);
      const steps = Math.max(4, Math.ceil((sweep / 360) * CURVE_STEPS * 4));
      for (let i = 1; i <= steps; i++) {
        const a = rad(from + (to - from) * (i / steps));
        cur = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
        pts.push(cur);
      }
      return api;
    },

    done: () => pts,
  };

  return api;
}

// Fit a drawn path into the plate's box and give it edges of one honest length.
function figure(raw, w, h, chord) {
  const fitted = fitToBox(raw, w, h);
  return resampleClosed(fitted, segmentsFor(perimeter(fitted), chord, 80, 900));
}

// A Santa reduced to one outline is three masses stacked, and it only reads if
// each is a different shape from the one below it: a half-round beard, a brim
// band standing proud of it on both sides, and a cone leaning off that brim
// with a ball on the end.
//
// The failure mode, arrived at twice before this drawing, is drawing the beard
// as a blob and the hat as another blob. Their edges then run into each other
// through the brim, the whole thing becomes one teardrop, and the brim reads as
// a bar stuck through it. Hence the semicircle, which nothing else here is, and
// the cone whose edges both run strictly rightward as they rise so neither can
// bulge back out and rejoin the beard.
function santa(w, h, chord) {
  // The three masses step in width -- cone 44, beard 84, brim 104 -- so each
  // one visibly starts where the last stopped.
  return figure(pen()
    .move(30, 68)
    .curve(34, 88, 52, 102, 68.9, 109)        // the cone, leaning right
    .arc(80, 106, 11.5, 165, -100)            // over the pom-pom
    .curve(76, 86, 76, 76, 74, 68)            // the cone's underside
    .line(97, 68)                             // the brim, along its top
    .curve(104, 67, 104, 47, 97, 46)          // the brim's right end
    .line(94, 46)                             // under the brim
    .arc(52, 46, 42, 0, -180)                 // the beard, half-round
    .line(7, 46)                              // under the brim again
    .curve(0, 47, 0, 67, 7, 68)               // the brim's left end
    .line(30, 68)                             // and back along its top
    .done(), w, h, chord);
}

// A head and two ears. The ears are drawn as one stroke each rather than as
// outlines, so their inner and outer edges stay the same distance apart and
// there is room for a column of studs up them.
function bunny(w, h, chord) {
  return figure(pen()
    .move(66, 55)
    .curve(76, 75, 86, 96, 84, 114)           // right ear, outer edge
    .curve(83, 122, 74, 122, 71, 114)         // right ear tip
    .curve(66, 96, 58, 74, 54, 57)            // right ear, inner edge
    .curve(52, 55, 48, 55, 46, 57)            // between the ears
    .curve(42, 74, 34, 96, 29, 114)           // left ear, inner edge
    .curve(26, 122, 17, 122, 16, 114)         // left ear tip
    .curve(14, 96, 24, 75, 34, 55)            // left ear, outer edge
    .curve(14, 52, 10, 22, 26, 8)             // head, left side
    .curve(40, -4, 60, -4, 74, 8)             // head, underneath
    .curve(90, 22, 86, 52, 66, 55)            // head, right side
    .done(), w, h, chord);
}

// A stroke of constant width following a hook: up the shaft, round the crook,
// and back down the other side, with a round cap at each end. Drawn from the
// centreline so the cane is the same thickness the whole way along.
function candycane(w, h, chord) {
  const cx = 40;
  const cy = 82;
  const r = 25;          // radius of the hook, on the centreline
  const t = 9;           // half the width of the cane
  const shaft = cx + r;  // the centreline of the straight part
  const end = 215;       // how far round the hook curls

  const ex = cx + Math.cos(rad(end)) * r;
  const ey = cy + Math.sin(rad(end)) * r;

  return figure(pen()
    .move(shaft + t, 0)
    .line(shaft + t, cy)                      // up the outside of the shaft
    .arc(cx, cy, r + t, 0, end)               // round the outside of the hook
    .arc(ex, ey, t, end, end + 180)           // cap the end of the hook
    .arc(cx, cy, r - t, end, 0)               // back round the inside
    .line(shaft - t, 0)                       // down the inside of the shaft
    .arc(shaft, 0, t, 180, 360)               // cap the bottom
    .done(), w, h, chord);
}

// A wide body under a stem that leans, because a stem that stands straight up
// reads as a stalk of something else.
function pumpkin(w, h, chord) {
  return figure(pen()
    .move(43, 80)
    .curve(42, 92, 44, 100, 52, 104)          // the stem, going up
    .curve(58, 106, 63, 104, 63, 100)         // over the top of the stem
    .curve(60, 100, 56, 98, 54, 94)           // back down its inside
    .curve(52, 90, 54, 84, 57, 80)            // to where it meets the body
    .curve(78, 82, 98, 68, 98, 44)            // body, right shoulder and side
    .curve(98, 18, 78, 2, 50, 2)              // body, underneath right
    .curve(22, 2, 2, 18, 2, 44)               // body, underneath left
    .curve(2, 68, 22, 82, 43, 80)             // body, left side and shoulder
    .done(), w, h, chord);
}

// A dome on straight sides, hemmed with four scallops. No eyes: they would be
// holes in the plate, and a plate with holes in it is two plates.
function ghost(w, h, chord) {
  const hem = 30;
  const p = pen().move(0, hem).line(0, 86).arc(50, 86, 50, 180, 0).line(100, hem);
  const scallops = 4;
  const r = 50 / scallops;
  for (let i = 0; i < scallops; i++) {
    p.arc(100 - r * (2 * i + 1), hem, r, 0, -180);
  }
  return figure(p.done(), w, h, chord);
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

/** The plate's own area: the outer ring less whatever is cut out of it. */
export function ringsArea(rings) {
  let area = Math.abs(polygonArea(rings.outer));
  for (const hole of rings.holes) area -= Math.abs(polygonArea(hole));
  return area;
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
 * Whether a point is on the plate: inside the outer ring and in none of the
 * holes.
 */
export function inMaterial(rings, x, y) {
  if (!pointInPolygon(rings.outer, x, y)) return false;
  for (const hole of rings.holes) if (pointInPolygon(hole, x, y)) return false;
  return true;
}

/** Distance to the nearest edge of the plate, counting the edges of holes. */
export function distanceToEdge(rings, x, y) {
  let best = distanceToOutline(rings.outer, x, y);
  for (const hole of rings.holes) {
    const d = distanceToOutline(hole, x, y);
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
 * stud circle, plus `margin`, lies on the plate, so no stud is ever left hanging
 * over an edge — the inside edge of a letter's counter included.
 *
 * Returns the kept positions along with their grid coordinates, which the
 * patterns need to reason about neighbours.
 */
export function studGrid(rings, { nx, ny, pitch, radius, margin = 0.3, pattern = 'full' }) {
  const need = radius + margin;
  const kept = [];
  const occupied = new Set();

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i - (nx - 1) / 2) * pitch;
      const y = (j - (ny - 1) / 2) * pitch;
      if (!inMaterial(rings, x, y)) continue;
      if (distanceToEdge(rings, x, y) < need) continue;
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

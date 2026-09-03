// Parametric LEGO-compatible plate geometry.
//
// The mesh is built closed: the bottom face, the side wall, the top face with a
// circular hole per stud, and a cylinder sewn into each of those holes. Nothing
// overlaps and nothing is left open, so the STL is a solid a slicer can take at
// face value rather than a pile of intersecting bodies it has to union first.
//
// This module is the single authority on what a plate is. The browser imports
// it to draw the preview and write the download, and the backend imports the
// same file to build the print file for an order — so the two can never drift
// into producing different geometry from the same numbers.

import { earcut } from './earcut.js';
import {
  SHAPES, shapeById, buildOutline, studGrid, ringsArea,
  inMaterial, distanceToEdge, glyphAspect,
  FONTS, CHARACTERS, fontById, GlyphError,
} from './shapes.js';

export { SHAPES, shapeById, FONTS, CHARACTERS, fontById };

export class SpecError extends Error {}

/**
 * The stud systems on offer, in millimetres.
 *
 * These are the real figures, not a print of them. The pitch especially: 8 mm
 * is a lattice a real brick also sits on, so it is not a number to adjust. A
 * plate whose pitch is 1 % out is 0.24 mm out across a 2x4 brick and 0.56 mm
 * across a 1x8, and a brick is rigid — it binds rather than stretching to
 * meet the studs. Duplo is the same construction at twice the pitch.
 */
export const SYSTEMS = [
  {
    id: 'lego',
    label: 'Compatível LEGO',
    pitch: 8,
    clearance: 0.2,
    studDiameter: 4.8,
    studHeight: 1.8,
    // LEGO's real baseplate slab. MIN_THICKNESS raises what actually gets
    // built; this stays the figure the reference mesh was derived from.
    thickness: 1.3,
    studWall: 1,
  },
  {
    id: 'duplo',
    label: 'Compatível Duplo',
    pitch: 16,
    clearance: 0.4,
    studDiameter: 9.35,
    studHeight: 4,
    thickness: 2.6,
    studWall: 1.8,
  },
];

export const systemById = (id) => SYSTEMS.find((s) => s.id === id);

export const PATTERNS = [
  { id: 'full', label: 'Todos os pinos' },
  { id: 'border', label: 'Só o contorno' },
  { id: 'checker', label: 'Xadrez' },
  { id: 'none', label: 'Sem pinos (placa lisa)' },
];

/**
 * Contour quality. `chord` is how far the outline may cut a corner, and
 * `studSegments` how many sides a stud is drawn with — the two together decide
 * the triangle count, which is the only thing quality actually costs.
 */
export const QUALITIES = {
  draft: { label: 'Rascunho — ficheiro pequeno', chord: 0.8, studSegments: 12 },
  normal: { label: 'Normal', chord: 0.4, studSegments: 20 },
  fine: { label: 'Fina — contornos suaves', chord: 0.2, studSegments: 32 },
};

/**
 * The thinnest plate worth printing.
 *
 * LEGO's own baseplate is 1.3 mm, which is what the reference mesh measures and
 * what the SYSTEMS table records — but that is an injection moulding, and
 * 1.3 mm of FDM plastic over 200 mm is floppy, warps off the bed at the corners,
 * and arrives bent. Two millimetres is the floor for something worth selling,
 * so it overrides the system's own figure rather than the other way round.
 *
 * Nothing about compatibility changes: a brick fits a 2 mm plate exactly as it
 * fits a 1.3 mm one, it just sits 0.7 mm higher.
 */
export const MIN_THICKNESS = 2;

// Ceilings. A plate is cheap to generate but not free, and a spec arriving over
// HTTP must not be able to ask for an unbounded mesh.
export const LIMITS = {
  studs: 96,          // per side
  maxStuds: 6000,     // positions on the grid
  studTrim: [-0.4, 0.2],
  thickness: [MIN_THICKNESS, 12],
  margin: [0, 4],
};

export const DEFAULTS = {
  system: 'lego',
  shape: 'rect',
  width: 28,
  depth: 25,
  // How much to take off the stud, in millimetres of diameter. Negative
  // because FDM lays a bead that bulges: a stud modelled at its nominal 4.8 mm
  // comes off the bed nearer 4.9 and will not enter a brick. This is the one
  // number to calibrate, and it changes nothing but grip.
  studTrim: -0.1,
  pattern: 'full',
  quality: 'normal',
  hollowStuds: false,
  margin: 0.3,
  corner: 0,
  sides: 6,
  rotation: 0,
  points: 5,
  innerRatio: 0.5,
  arm: 5,
  armX: 6,
  armY: 6,
  char: 'A',
  font: 'sans',
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/**
 * Normalise and bound an incoming spec.
 *
 * Anything missing falls back to the default; anything out of range is clamped
 * rather than refused, because a slider that has been dragged past a limit and
 * a hand-written value that is merely optimistic both mean the same thing. Only
 * a name this build does not know — an unknown shape or system — is an error,
 * since there is no sensible value to clamp it to.
 */
export function normaliseSpec(input = {}) {
  const spec = { ...DEFAULTS };

  if (input.system != null && input.system !== '') {
    if (!systemById(input.system)) throw new SpecError(`Unknown system "${String(input.system).slice(0, 24)}".`);
    spec.system = input.system;
  }
  if (input.shape != null && input.shape !== '') {
    if (!shapeById(input.shape)) throw new SpecError(`Unknown shape "${String(input.shape).slice(0, 24)}".`);
    spec.shape = input.shape;
  }
  if (input.pattern != null && input.pattern !== '') {
    if (!PATTERNS.some((p) => p.id === input.pattern)) {
      throw new SpecError(`Unknown stud pattern "${String(input.pattern).slice(0, 24)}".`);
    }
    spec.pattern = input.pattern;
  }
  if (input.quality != null && input.quality !== '') {
    if (!QUALITIES[input.quality]) throw new SpecError(`Unknown quality "${String(input.quality).slice(0, 24)}".`);
    spec.quality = input.quality;
  }

  const sys = systemById(spec.system);

  spec.width = Math.round(clamp(num(input.width, DEFAULTS.width), [1, LIMITS.studs]));
  spec.depth = Math.round(clamp(num(input.depth, DEFAULTS.depth), [1, LIMITS.studs]));
  spec.studTrim = clamp(num(input.studTrim, DEFAULTS.studTrim), LIMITS.studTrim);
  spec.margin = clamp(num(input.margin, DEFAULTS.margin), LIMITS.margin);
  spec.hollowStuds = !!input.hollowStuds;

  // The dimensions that decide whether a brick fits belong to the system, not
  // to whoever is holding the sliders. The pitch, the stud, and the clearance
  // that lets two plates sit side by side are what compatibility *is*: alter
  // any of them and the plate is still a plate, but nothing clicks onto it.
  // They are taken from the chosen system, and a caller that sends its own is
  // ignored rather than obeyed — including a spec stored by an older build
  // that let them be edited, which is how those heal.
  spec.pitch = sys.pitch;
  spec.clearance = sys.clearance;
  spec.studDiameter = sys.studDiameter;
  spec.studHeight = sys.studHeight;
  spec.studWall = sys.studWall;

  // Thickness is the exception, and a real choice: a thicker plate is stiffer
  // and a thinner one cheaper, and a brick fits either way. It still cannot go
  // below MIN_THICKNESS, which is where a printed plate stops being rigid
  // enough to sell — including when the system's own figure is thinner, as
  // LEGO's 1.3 mm baseplate is.
  spec.thickness = clamp(num(input.thickness, sys.thickness), LIMITS.thickness);

  // Shape parameters. Read for every shape so switching shape and back does not
  // silently lose what was set, and bounded so a stored spec cannot smuggle a
  // value past the sliders.
  spec.corner = clamp(num(input.corner, DEFAULTS.corner), [0, 400]);
  spec.sides = Math.round(clamp(num(input.sides, DEFAULTS.sides), [3, 24]));
  spec.rotation = clamp(num(input.rotation, DEFAULTS.rotation), [-180, 180]);
  spec.points = Math.round(clamp(num(input.points, DEFAULTS.points), [3, 24]));
  spec.innerRatio = clamp(num(input.innerRatio, DEFAULTS.innerRatio), [0.15, 0.95]);
  spec.arm = clamp(num(input.arm, DEFAULTS.arm), [1, LIMITS.studs]);
  spec.armX = clamp(num(input.armX, DEFAULTS.armX), [1, LIMITS.studs]);
  spec.armY = clamp(num(input.armY, DEFAULTS.armY), [1, LIMITS.studs]);

  if (input.font != null && input.font !== '') {
    if (!fontById(input.font)) throw new SpecError(`Unknown font "${String(input.font).slice(0, 24)}".`);
    spec.font = input.font;
  }
  if (input.char != null && input.char !== '') {
    // Uppercase only, and one of them. Lowercase is not a rendering choice
    // here: an "i" is a stem and a separate dot, and a plate is one piece.
    //
    // The character is taken before it is upper-cased, not after. Some letters
    // upper-case into two — "ß" becomes "SS" — and doing it the other way round
    // would quietly hand back a plate reading S.
    const ch = String(input.char).trim().slice(0, 1).toUpperCase();
    if (ch.length !== 1 || !CHARACTERS.includes(ch)) {
      throw new SpecError(`"${String(input.char).slice(0, 4)}" is not one of A-Z or 0-9.`);
    }
    spec.char = ch;
  }

  // A letter's width is not the customer's to set — squash it and it becomes a
  // different letter — so it is worked back from the glyph and the height they
  // did set, and the box the outline is fitted to is the shape of the glyph.
  if (spec.shape === 'text') {
    const { pitch, clearance } = spec;
    const boxHeight = spec.depth * pitch - clearance;
    const wanted = (boxHeight * glyphAspect(spec.font, spec.char) + clearance) / pitch;
    spec.width = Math.max(1, Math.min(LIMITS.studs, Math.round(wanted)));
  }

  if (spec.width * spec.depth > LIMITS.maxStuds) {
    throw new SpecError(
      `${spec.width} x ${spec.depth} is ${spec.width * spec.depth} stud positions; ` +
      `the ceiling is ${LIMITS.maxStuds}.`,
    );
  }

  // A stud has to fit in its cell with a wall left between neighbours. Nothing
  // a caller sends can break this any more; it guards the SYSTEMS table against
  // a badly entered row.
  if (spec.studDiameter >= spec.pitch - 0.2) {
    throw new SpecError(`System "${spec.system}" has studs too wide for its own pitch.`);
  }

  return spec;
}

/**
 * The millimetre figures a spec works out to, fit scale included.
 *
 * Every downstream consumer — geometry, preview, statistics, the printed
 * summary — reads these rather than re-deriving them, so the number quoted to
 * the customer is by construction the number that was built.
 */
export function resolve(spec) {
  const { pitch, clearance } = spec;
  const q = QUALITIES[spec.quality];

  // Nothing here is scaled. A plate shares its grid with real bricks, so the
  // pitch is the one dimension that must come out of the printer at exactly
  // the number LEGO uses; stretching the whole model to fix a fit problem
  // moves every stud away from where a brick expects it. Grip is corrected on
  // the stud alone, which is what `studTrim` is.
  return {
    pitch,
    clearance,
    radius: Math.max(0.2, spec.studDiameter + spec.studTrim) / 2,
    studHeight: spec.studHeight,
    thickness: spec.thickness,
    studWall: spec.studWall,
    margin: spec.margin,
    // The footprint of an n-stud run: n pitches, less the clearance that keeps
    // two plates from binding when they are laid side by side.
    width: spec.width * pitch - clearance,
    depth: spec.depth * pitch - clearance,
    height: spec.thickness + spec.studHeight,
    chord: q.chord,
    studSegments: q.studSegments,
  };
}

// Circles and cell squares both start at their bottom-left corner and run
// counter-clockwise, so point k of a stud circle faces point k of the square
// around it. That alignment is what lets the interior of the plate be sewn
// cell by cell, with no triangle in the ring between them crossing another.
const PHASE = (-3 * Math.PI) / 4;

// A circle of `seg` points, wound counter-clockwise about its centre.
function circlePoints(cx, cy, r, seg) {
  const pts = new Array(seg);
  for (let k = 0; k < seg; k++) {
    const a = PHASE + (k / seg) * Math.PI * 2;
    pts[k] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  }
  return pts;
}

// The pitch-sized square a stud sits in the middle of, sampled with `seg / 4`
// points per side starting at each corner. Two neighbouring cells therefore
// sample the side they share at exactly the same points, in opposite
// directions, which is what makes the tiled face close.
function squarePoints(cx, cy, half, seg) {
  const per = seg / 4;
  const step = (half * 2) / per;
  const pts = new Array(seg);
  let n = 0;
  for (let t = 0; t < per; t++) pts[n++] = [cx - half + step * t, cy - half];
  for (let t = 0; t < per; t++) pts[n++] = [cx + half, cy - half + step * t];
  for (let t = 0; t < per; t++) pts[n++] = [cx + half - step * t, cy + half];
  for (let t = 0; t < per; t++) pts[n++] = [cx - half, cy + half - step * t];
  return pts;
}

/**
 * Build the plate.
 *
 * Returns a flat triangle soup — nine floats per triangle, the layout both
 * three.js and the STL writer want — plus the numbers worth showing.
 */
export function buildPlate(input) {
  const spec = normaliseSpec(input);
  const d = resolve(spec);

  let rings;
  try {
    rings = buildOutline(spec, d.width, d.depth, d.chord);
  } catch (err) {
    if (err instanceof GlyphError) throw new SpecError(err.message);
    throw err;
  }
  if (rings.outer.length < 3) throw new SpecError('Those dimensions leave no plate to build.');

  const studs = studGrid(rings, {
    nx: spec.width,
    ny: spec.depth,
    pitch: d.pitch,
    radius: d.radius,
    margin: d.margin,
    pattern: spec.pattern,
  });

  const seg = d.studSegments;
  const T = d.thickness;
  const SH = d.studHeight;
  const R = d.radius;
  // A bore is only worth cutting if a printable wall is left around it.
  const bore = spec.hollowStuds ? Math.max(0, R - d.studWall) : 0;
  const hollow = bore >= 0.4;

  // Triangles land straight in a typed array that doubles when it fills. A
  // large plate is half a million floats; pushing those into a plain array
  // costs more than the triangulation does.
  let data = new Float32Array(4096 * 9);
  let n = 0;
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    if (n + 9 > data.length) {
      const grown = new Float32Array(data.length * 2);
      grown.set(data);
      data = grown;
    }
    data[n] = ax; data[n + 1] = ay; data[n + 2] = az;
    data[n + 3] = bx; data[n + 4] = by; data[n + 5] = bz;
    data[n + 6] = cx; data[n + 7] = cy; data[n + 8] = cz;
    n += 9;
  };

  // --- top face -------------------------------------------------------------

  const studRings = studs.map((stud) => circlePoints(stud.x, stud.y, R, seg));
  topFace(push, {
    rings, studs, studRings, T, seg,
    nx: spec.width, ny: spec.depth, pitch: d.pitch,
  });

  // --- bottom face: the plate's own rings, facing down -----------------------

  const bottom = ringCoords(rings.outer, rings.holes);
  emitFace(push, bottom.coords, earcut(bottom.coords, bottom.holes, 2, true), 0, -1);

  // --- side wall ------------------------------------------------------------
  //
  // The same code walks the outer ring and every hole. That works because the
  // holes run the opposite way round, so "the material is on the left" holds
  // for all of them and the wall's normal comes out pointing away from the
  // plate in both cases — outward at the edge, inward into the hole.

  for (const ring of [rings.outer, ...rings.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      push(x0, y0, 0, x1, y1, 0, x1, y1, T);
      push(x0, y0, 0, x1, y1, T, x0, y0, T);
    }
  }

  // --- studs ----------------------------------------------------------------

  const top = T + SH;
  for (let s = 0; s < studRings.length; s++) {
    const ring = studRings[s];
    const { x: cx, y: cy } = studs[s];

    // Outer wall. Its lower ring is literally the hole in the top face, so the
    // two share every vertex and the seam cannot open.
    for (let k = 0; k < seg; k++) {
      const [x0, y0] = ring[k];
      const [x1, y1] = ring[(k + 1) % seg];
      push(x0, y0, T, x1, y1, T, x1, y1, top);
      push(x0, y0, T, x1, y1, top, x0, y0, top);
    }

    if (!hollow) {
      // Flat cap, fanned from the first point on the ring.
      for (let k = 1; k < seg - 1; k++) {
        push(ring[0][0], ring[0][1], top, ring[k][0], ring[k][1], top, ring[k + 1][0], ring[k + 1][1], top);
      }
      continue;
    }

    // Hollow stud: an annulus on top, a bore straight down to the top of the
    // slab, and a floor closing it there. Lighter, and the thin wall gives the
    // brick above something to grip.
    const inner = circlePoints(cx, cy, bore, seg);
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      // Top annulus.
      push(ring[k][0], ring[k][1], top, ring[k1][0], ring[k1][1], top, inner[k1][0], inner[k1][1], top);
      push(ring[k][0], ring[k][1], top, inner[k1][0], inner[k1][1], top, inner[k][0], inner[k][1], top);
      // Bore wall. Wound the opposite way round from the outer wall, so its
      // normal points at the axis and its top edge meets the annulus head on.
      push(inner[k][0], inner[k][1], T, inner[k1][0], inner[k1][1], top, inner[k1][0], inner[k1][1], T);
      push(inner[k][0], inner[k][1], T, inner[k][0], inner[k][1], top, inner[k1][0], inner[k1][1], top);
    }
    // Bore floor, level with the top of the slab and facing up into the bore.
    for (let k = 1; k < seg - 1; k++) {
      push(inner[0][0], inner[0][1], T, inner[k][0], inner[k][1], T, inner[k + 1][0], inner[k + 1][1], T);
    }
  }

  const positions = data.subarray(0, n);

  return {
    spec,
    dims: d,
    rings,
    studs,
    positions,
    triangles: positions.length / 9,
    volume: meshVolume(positions),
    size: { x: d.width, y: d.depth, z: d.height },
    area: ringsArea(rings),
  };
}

// Flatten a set of rings into the flat coordinate array and hole-start indices
// the triangulator takes. `extra` rings are appended as further holes, which is
// how the stud circles and the tiled interior's boundary get in.
function ringCoords(outer, holes, extra = []) {
  const coords = [];
  for (const [x, y] of outer) coords.push(x, y);
  const starts = [];
  for (const ring of [...holes, ...extra]) {
    starts.push(coords.length / 2);
    for (const [x, y] of ring) coords.push(x, y);
  }
  return { coords, holes: starts.length ? starts : null };
}

// ---------------------------------------------------------------------------
// The top face
// ---------------------------------------------------------------------------
//
// Handing the whole face to the triangulator as one outline with a hole per
// stud is correct but not affordable: bridging n holes into a growing ring
// costs O(n²), and a bed-sized plate has a couple of thousand studs. So the
// face is split in two. Every grid cell that lies wholly inside the outline is
// sewn directly — a ring of quads from the stud circle out to the cell square,
// or a plain fan where the pattern left no stud — and only the border band
// that is left over goes to the triangulator, carrying the handful of studs
// whose cells hang over the edge. The band's inner boundary is sampled at
// exactly the points the cells use, so the two halves meet without a seam.
//
// Falls back to triangulating the whole face when the tiling does not apply:
// a plate too small to have an interior, or a stud layout whose interior is
// not a simple region.

function topFace(push, o) {
  if (!tiledTopFace(push, o)) {
    const flat = ringCoords(o.rings.outer, o.rings.holes, o.studRings);
    emitFace(push, flat.coords, earcut(flat.coords, flat.holes, 2, true), o.T, +1);
  }
}

function tiledTopFace(push, { rings, studs, studRings, T, seg, nx, ny, pitch }) {
  const half = pitch / 2;
  // A cell is wholly inside when its centre is inside and no part of the
  // outline comes within the cell's own circumradius of that centre.
  const reach = pitch * Math.SQRT1_2;
  const cx = (i) => (i - (nx - 1) / 2) * pitch;
  const cy = (j) => (j - (ny - 1) / 2) * pitch;

  const inside = new Set();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = cx(i);
      const y = cy(j);
      if (!inMaterial(rings, x, y)) continue;
      if (distanceToEdge(rings, x, y) < reach) continue;
      inside.add(j * nx + i);
    }
  }
  if (!inside.size) return false;

  const loops = cellLoops(inside, nx, ny);
  if (!loops) return false;

  // --- the band around the tiled interior ---
  //
  // The band is everything the tiling did not cover: the plate's own rings,
  // with the tiled region and the leftover studs punched out of it.
  const { coords, holes: ringHoles } = ringCoords(rings.outer, rings.holes);
  const holes = ringHoles || [];

  const per = seg / 4;
  for (const loop of loops) {
    holes.push(coords.length / 2);
    for (const [ai, aj, bi, bj] of loop) {
      // Each boundary edge is one side of one cell, sampled the same way the
      // cell itself samples it.
      const ax = cx(ai) - half;
      const ay = cy(aj) - half;
      const dx = (cx(bi) - half - ax) / per;
      const dy = (cy(bj) - half - ay) / per;
      for (let t = 0; t < per; t++) coords.push(ax + dx * t, ay + dy * t);
    }
  }

  for (let s = 0; s < studs.length; s++) {
    if (inside.has(studs[s].j * nx + studs[s].i)) continue;
    holes.push(coords.length / 2);
    for (const [x, y] of studRings[s]) coords.push(x, y);
  }

  emitFace(push, coords, earcut(coords, holes, 2, true), T, +1);

  // --- the tiled interior ---
  const ringAt = new Map();
  for (let s = 0; s < studs.length; s++) ringAt.set(studs[s].j * nx + studs[s].i, studRings[s]);

  for (const cell of inside) {
    const i = cell % nx;
    const j = (cell - i) / nx;
    const sq = squarePoints(cx(i), cy(j), half, seg);
    const ring = ringAt.get(cell);

    if (!ring) {
      // No stud here — the pattern skipped it, so the cell is simply flat.
      for (let k = 1; k < seg - 1; k++) {
        push(sq[0][0], sq[0][1], T, sq[k][0], sq[k][1], T, sq[k + 1][0], sq[k + 1][1], T);
      }
      continue;
    }

    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      push(sq[k][0], sq[k][1], T, sq[k1][0], sq[k1][1], T, ring[k1][0], ring[k1][1], T);
      push(sq[k][0], sq[k][1], T, ring[k1][0], ring[k1][1], T, ring[k][0], ring[k][1], T);
    }
  }

  return true;
}

/**
 * The boundary of a set of grid cells, as loops of directed cell-corner steps
 * wound counter-clockwise about the set.
 *
 * Returns null when the result is not a set of plain outer boundaries — a hole
 * in the middle of the set, or a corner where two loops pinch — since the
 * caller has a slower path that copes with anything.
 */
function cellLoops(cells, nx, ny) {
  const has = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && cells.has(j * nx + i);
  const corner = (i, j) => j * (nx + 1) + i;

  // Each corner starts at most one boundary edge for a well-formed set; a
  // second one there means the boundary pinches, which is the bail-out.
  const from = new Map();
  const add = (ai, aj, bi, bj) => {
    const k = corner(ai, aj);
    if (from.has(k)) return false;
    from.set(k, [ai, aj, bi, bj]);
    return true;
  };

  for (const cell of cells) {
    const i = cell % nx;
    const j = (cell - i) / nx;
    if (!has(i, j - 1) && !add(i, j, i + 1, j)) return null;
    if (!has(i + 1, j) && !add(i + 1, j, i + 1, j + 1)) return null;
    if (!has(i, j + 1) && !add(i + 1, j + 1, i, j + 1)) return null;
    if (!has(i - 1, j) && !add(i, j + 1, i, j)) return null;
  }

  const loops = [];
  const seen = new Set();

  for (const [startKey, startEdge] of from) {
    if (seen.has(startKey)) continue;
    const loop = [];
    let edge = startEdge;
    let key = startKey;
    for (;;) {
      seen.add(key);
      loop.push(edge);
      key = corner(edge[2], edge[3]);
      if (key === startKey) break;
      edge = from.get(key);
      if (!edge || seen.has(key)) return null;
    }

    // Twice the enclosed area in cell units. A negative loop is a hole in the
    // set, which the band cannot express as a hole of its own.
    let twice = 0;
    for (const [ai, aj, bi, bj] of loop) twice += ai * bj - bi * aj;
    if (twice <= 0) return null;

    loops.push(loop);
  }

  return loops.length ? loops : null;
}

// Emit an earcut result at a fixed Z, with each triangle wound so its normal
// points along `sign`. Deriving the winding from the triangle itself keeps this
// independent of whichever convention the triangulator happened to return.
//
// Zero-area triangles are kept, not dropped. The triangulator is asked to
// preserve every vertex it was handed, and where a vertex sits mid-way along an
// otherwise straight run it can only be consumed by a flat triangle. Those
// triangles are what stitch such a vertex to the geometry on the other side of
// the seam: drop them and the seam becomes a T-junction, which is the classic
// way a mesh that looks closed still slices with a hairline crack in it.
function emitFace(push, coords, indices, z, sign) {
  // The triangulator clips every ear from one ring, so all its output shares
  // one orientation. Read that orientation off the first triangle with an area
  // to read it from, then apply the same decision to all of them — a flat
  // triangle has no orientation of its own, and guessing per-triangle would
  // point some of them the wrong way round and undo the stitching.
  let flip = false;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 2;
    const b = indices[t + 1] * 2;
    const c = indices[t + 2] * 2;
    const twice = (coords[b] - coords[a]) * (coords[c + 1] - coords[a + 1]) -
                  (coords[c] - coords[a]) * (coords[b + 1] - coords[a + 1]);
    if (twice !== 0) {
      flip = (twice > 0) !== (sign > 0);
      break;
    }
  }

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 2;
    const b = indices[t + (flip ? 2 : 1)] * 2;
    const c = indices[t + (flip ? 1 : 2)] * 2;
    push(coords[a], coords[a + 1], z, coords[b], coords[b + 1], z, coords[c], coords[c + 1], z);
  }
}

/** Enclosed volume in mm³, by the divergence theorem over the closed mesh. */
export function meshVolume(positions) {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

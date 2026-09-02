// A slicer, enough of one to price a print.
//
// The mesh's own volume is what the plate would weigh if it were solid, and a
// print never is: it is a few perimeters, a solid skin top and bottom, and
// mostly air in between. Pricing off the solid volume overcharges every
// customer, and by a different amount for every shape — which is exactly the
// problem with quoting a geometry you cannot predict.
//
// So this does what a slicer does. It cuts the triangles at each layer height,
// fills the cross-section onto a grid, and works out cell by cell which
// material is perimeter, which is solid skin because there is air above or
// below it, and which is sparse infill. That gives extruded volume directly,
// and the time follows from the path length each feature implies at the speed
// it is printed. What it does not do is plan actual toolpaths, so travel is
// estimated from how many separate islands a layer has rather than measured —
// which matters, because a baseplate's top layers are hundreds of little
// circles and the head spends real time hopping between them.
//
// It runs on the triangle soup, not on the plate's parameters, so it keeps
// working when the geometry changes. The browser and the backend both call it,
// on the same mesh, and get the same answer.

/**
 * How the shop prints. `walls` and the shell counts are in lines and layers,
 * which is how a slicer states them, and speeds are mm/s.
 */
export const MACHINE = {
  lineWidth: 0.42,
  firstLayerHeight: 0.25,
  filamentDiameter: 1.75,
  density: 1.24,              // PLA, g/cm³

  perimeterSpeed: 45,
  solidSpeed: 90,
  infillSpeed: 120,
  firstLayerSpeed: 22,
  travelSpeed: 200,

  // Nothing prints at its nominal speed: every corner is an acceleration ramp,
  // and a surface covered in 5 mm circles is nearly all corner. This is the
  // fraction of nominal actually achieved, and it is the single biggest reason
  // a naive length/speed estimate comes out optimistic.
  speedFactor: 0.72,

  // Per layer, for the z move, retractions and the like.
  layerOverhead: 1.1,
};

/** Print profiles, in the terms a slicer states them. */
export const PROFILES = {
  draft: {
    label: 'Rápida — camada 0.28 mm',
    layerHeight: 0.28, walls: 2, topLayers: 3, bottomLayers: 3, infill: 0.15,
  },
  normal: {
    label: 'Normal — camada 0.2 mm',
    layerHeight: 0.2, walls: 2, topLayers: 4, bottomLayers: 3, infill: 0.15,
  },
  strong: {
    label: 'Reforçada — camada 0.16 mm',
    layerHeight: 0.16, walls: 3, topLayers: 5, bottomLayers: 4, infill: 0.3,
  },
};

export const DEFAULT_PROFILE = 'normal';
export const profileById = (id) => PROFILES[id] || PROFILES[DEFAULT_PROFILE];

// The grid is one extrusion wide per cell, so eroding it by a cell is exactly
// what laying down one perimeter does. A plate big enough to blow the budget
// gets a coarser grid and a correspondingly smaller erosion instead — the
// answer stays right, it just gets grainier.
const MAX_CELLS_PER_LAYER = 900_000;
const MAX_TOTAL_CELLS = 24_000_000;

/**
 * Slice a triangle soup and say what printing it costs in material and time.
 *
 * `positions` is the flat nine-floats-per-triangle array the plate builder
 * produces. Returns grams, metres of filament, hours, and the breakdown the
 * three of those came from.
 */
export function slicePrint(positions, options = {}) {
  const m = { ...MACHINE, ...(options.machine || {}) };
  const p = { ...profileById(options.profile), ...(options.overrides || {}) };

  const bounds = meshBounds(positions);
  if (!bounds) return empty(m, p);

  const height = bounds.maxZ - bounds.minZ;
  if (!(height > 0)) return empty(m, p);

  // --- layers ---------------------------------------------------------------

  const first = Math.min(m.firstLayerHeight, height);
  const rest = Math.max(0, height - first);
  const layerCount = 1 + Math.ceil(rest / p.layerHeight - 1e-9);
  const zAt = (i) => (i === 0
    ? bounds.minZ + first / 2
    : bounds.minZ + first + (i - 0.5) * p.layerHeight);
  const thicknessAt = (i) => (i === 0 ? first : Math.min(p.layerHeight, height - first - (i - 1) * p.layerHeight));

  // --- grid -----------------------------------------------------------------

  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  let cell = m.lineWidth;
  let nx = Math.max(1, Math.ceil(width / cell) + 2);
  let ny = Math.max(1, Math.ceil(depth / cell) + 2);

  // Coarsen rather than refuse: a quote for a plate too big to grid finely is
  // still worth more than no quote.
  const budget = Math.min(MAX_CELLS_PER_LAYER, MAX_TOTAL_CELLS / Math.max(1, layerCount));
  if (nx * ny > budget) {
    const k = Math.sqrt((nx * ny) / budget);
    cell *= k;
    nx = Math.max(1, Math.ceil(width / cell) + 2);
    ny = Math.max(1, Math.ceil(depth / cell) + 2);
  }

  const originX = bounds.minX - cell;
  const originY = bounds.minY - cell;
  const cellArea = cell * cell;
  // One perimeter is one line wide, which is `lineWidth / cell` cells once the
  // grid has been coarsened.
  const erosions = Math.max(1, Math.round((p.walls * m.lineWidth) / cell));

  const grids = [];
  for (let i = 0; i < layerCount; i++) {
    grids.push(rasterise(positions, zAt(i), originX, originY, cell, nx, ny));
  }

  // --- what each cell is ----------------------------------------------------

  let wallVolume = 0;
  let solidVolume = 0;
  let sparseVolume = 0;
  let firstLayerVolume = 0;
  let seconds = 0;
  let modelVolume = 0;

  const interior = new Uint8Array(nx * ny);

  for (let i = 0; i < layerCount; i++) {
    const grid = grids[i];
    const h = thicknessAt(i);
    if (!(h > 0)) continue;

    erode(grid, interior, nx, ny, erosions);

    let wallCells = 0;
    let solidCells = 0;
    let sparseCells = 0;

    for (let c = 0; c < grid.length; c++) {
      if (!grid[c]) continue;
      if (!interior[c]) { wallCells++; continue; }
      // Skin is material that has air within the shell count above or below it,
      // which is what makes the top of a plate solid and its middle hollow.
      if (exposed(grids, i, c, p.topLayers, p.bottomLayers, layerCount)) solidCells++;
      else sparseCells++;
    }

    const wall = wallCells * cellArea * h;
    const solid = solidCells * cellArea * h;
    const sparse = sparseCells * cellArea * h * p.infill;

    wallVolume += wall;
    solidVolume += solid;
    sparseVolume += sparse;
    modelVolume += (wallCells + solidCells + sparseCells) * cellArea * h;

    // Everything on the first layer goes down at the first layer's speed, so it
    // is timed on its own rather than by feature.
    if (i === 0) {
      firstLayerVolume = wall + solid + sparse;
      seconds += pathLength(wall + solid + sparse, m.lineWidth, h) / (m.firstLayerSpeed * m.speedFactor);
    } else {
      seconds += pathLength(wall, m.lineWidth, h) / (m.perimeterSpeed * m.speedFactor);
      seconds += pathLength(solid, m.lineWidth, h) / (m.solidSpeed * m.speedFactor);
      seconds += pathLength(sparse, m.lineWidth, h) / (m.infillSpeed * m.speedFactor);
    }

    // Travel. Every separate island on a layer is somewhere the head has to fly
    // to; a plate's top layers are one island per stud, which is why a studded
    // plate takes longer than its material suggests.
    const islands = countIslands(grid, nx, ny);
    if (islands > 1) {
      const spread = Math.sqrt((width * depth) / islands);
      seconds += (islands * spread) / m.travelSpeed;
    }
    seconds += m.layerOverhead;
  }

  const volume = wallVolume + solidVolume + sparseVolume;
  const area = Math.PI * (m.filamentDiameter / 2) ** 2;

  return {
    grams: (volume / 1000) * m.density,
    metres: volume / area / 1000,
    hours: seconds / 3600,
    volumeMm3: volume,
    layers: layerCount,
    // What the same plate would take printed solid. The ratio of the two is the
    // whole reason for slicing rather than weighing the mesh.
    solidGrams: (modelVolume / 1000) * m.density,
    solidMm3: modelVolume,
    breakdown: {
      wallMm3: wallVolume,
      solidMm3: solidVolume,
      sparseMm3: sparseVolume,
      firstLayerMm3: firstLayerVolume,
    },
    profile: { ...p },
    machine: { ...m },
    grid: { cell, nx, ny },
    // The part's own bounding box. Shipping is priced off it, and for a plate
    // that matters more than the weight does.
    size: {
      x: bounds.maxX - bounds.minX,
      y: bounds.maxY - bounds.minY,
      z: height,
    },
  };
}

function empty(machine, profile) {
  return {
    grams: 0, metres: 0, hours: 0, volumeMm3: 0, layers: 0, solidGrams: 0,
    breakdown: { wallMm3: 0, solidMm3: 0, sparseMm3: 0, firstLayerMm3: 0 },
    profile: { ...profile }, machine: { ...machine }, grid: { cell: 0, nx: 0, ny: 0 },
    size: { x: 0, y: 0, z: 0 }, solidMm3: 0,
  };
}

// How far the head travels to lay a given volume down as a bead of the given
// cross-section.
const pathLength = (volume, lineWidth, layerHeight) => volume / (lineWidth * layerHeight);

function meshBounds(positions) {
  if (!positions || positions.length < 9) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * The solid cross-section at one height, filled onto the grid.
 *
 * Cutting the triangles gives a set of segments; a row of the grid is then
 * filled by where that row's line crosses them, taking every other span. That
 * is the same even-odd rule a slicer uses, and it needs the mesh to be closed —
 * which the plate builder guarantees and its tests check.
 */
function rasterise(positions, z, originX, originY, cell, nx, ny) {
  const grid = new Uint8Array(nx * ny);

  // Segments, bucketed by the grid rows they span, so a row only looks at the
  // few segments that can possibly cross it.
  const rows = new Array(ny);
  let segments = 0;

  for (let t = 0; t < positions.length; t += 9) {
    const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
    const bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5];
    const cx = positions[t + 6], cy = positions[t + 7], cz = positions[t + 8];

    const above = (az > z) + (bz > z) + (cz > z);
    if (above === 0 || above === 3) continue;

    const pts = [];
    edgeCut(ax, ay, az, bx, by, bz, z, pts);
    edgeCut(bx, by, bz, cx, cy, cz, z, pts);
    edgeCut(cx, cy, cz, ax, ay, az, z, pts);
    if (pts.length < 4) continue;

    const x0 = pts[0], y0 = pts[1], x1 = pts[2], y1 = pts[3];
    if (y0 === y1) continue;                       // horizontal: crosses no row line

    let j0 = Math.floor((Math.min(y0, y1) - originY) / cell);
    let j1 = Math.floor((Math.max(y0, y1) - originY) / cell);
    if (j1 < 0 || j0 >= ny) continue;
    if (j0 < 0) j0 = 0;
    if (j1 >= ny) j1 = ny - 1;

    for (let j = j0; j <= j1; j++) {
      (rows[j] || (rows[j] = [])).push(x0, y0, x1, y1);
    }
    segments++;
  }

  if (!segments) return grid;

  const crossings = [];
  for (let j = 0; j < ny; j++) {
    const bucket = rows[j];
    if (!bucket) continue;
    const y = originY + (j + 0.5) * cell;

    crossings.length = 0;
    for (let s = 0; s < bucket.length; s += 4) {
      const x0 = bucket[s], y0 = bucket[s + 1], x1 = bucket[s + 2], y1 = bucket[s + 3];
      // Half-open in y so a vertex shared by two segments is counted once.
      if ((y0 <= y) === (y1 <= y)) continue;
      crossings.push(x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const base = j * nx;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // A cell counts as material when its own centre is inside the span.
      // Filling every cell the span merely touches would round the plate up by
      // most of a line width all the way round every one of its edges — which
      // on a face covered in stud circles adds up to more material than the
      // solid would take.
      let i0 = Math.ceil((crossings[k] - originX) / cell - 0.5);
      let i1 = Math.floor((crossings[k + 1] - originX) / cell - 0.5);
      if (i1 < i0 || i1 < 0 || i0 >= nx) continue;
      if (i0 < 0) i0 = 0;
      if (i1 >= nx) i1 = nx - 1;
      for (let i = i0; i <= i1; i++) grid[base + i] = 1;
    }
  }

  return grid;
}

function edgeCut(x0, y0, z0, x1, y1, z1, z, out) {
  if ((z0 > z) === (z1 > z)) return;
  const t = (z - z0) / (z1 - z0);
  out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
}

/**
 * Peel `steps` cells off the edge of the filled region; what is left is what a
 * slicer would fill after laying its perimeters, and what was peeled is the
 * perimeters themselves.
 */
// Two scratch buffers, kept between calls and never shared with the caller's.
// Ping-ponging into the output array instead would leave it as the scratch for
// the next call whenever the pass count is odd, and the next erosion would then
// read and write the same memory.
const scratch = { size: 0, a: null, b: null };

function erodeBuffers(size) {
  if (scratch.size !== size) {
    scratch.size = size;
    scratch.a = new Uint8Array(size);
    scratch.b = new Uint8Array(size);
  }
  return scratch;
}

function erode(grid, out, nx, ny, steps) {
  if (steps < 1) {
    out.set(grid);
    return out;
  }

  const buffers = erodeBuffers(grid.length);
  let src = buffers.a;
  let dst = buffers.b;
  src.set(grid);

  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < ny; j++) {
      const base = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = base + i;
        if (!src[c]) { dst[c] = 0; continue; }
        // Anything on the grid's own edge counts as exposed, which is right:
        // the grid is padded by a cell, so it never clips the plate.
        dst[c] = (i > 0 && src[c - 1] && i < nx - 1 && src[c + 1] &&
                  j > 0 && src[c - nx] && j < ny - 1 && src[c + nx]) ? 1 : 0;
      }
    }
    const swap = src;
    src = dst;
    dst = swap;
  }

  out.set(src);
  return out;
}

// Whether a cell has air close enough above or below to need a solid skin.
// Off the end of the stack counts as air, which is what makes the very top and
// bottom of a plate solid.
function exposed(grids, layer, cell, topLayers, bottomLayers, layerCount) {
  for (let k = 1; k <= topLayers; k++) {
    const j = layer + k;
    if (j >= layerCount || !grids[j][cell]) return true;
  }
  for (let k = 1; k <= bottomLayers; k++) {
    const j = layer - k;
    if (j < 0 || !grids[j][cell]) return true;
  }
  return false;
}

// How many separate pieces the layer is in — one per stud, near the top of a
// plate, and each of them somewhere the head has to fly to.
function countIslands(grid, nx, ny) {
  const seen = countIslands.seen && countIslands.seen.length === grid.length
    ? countIslands.seen
    : (countIslands.seen = new Uint8Array(grid.length));
  seen.fill(0);

  const stack = [];
  let islands = 0;

  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    islands++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      const i = c % nx;
      if (i > 0 && grid[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (i < nx - 1 && grid[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (c >= nx && grid[c - nx] && !seen[c - nx]) { seen[c - nx] = 1; stack.push(c - nx); }
      if (c + nx < grid.length && grid[c + nx] && !seen[c + nx]) { seen[c + nx] = 1; stack.push(c + nx); }
    }
  }
  return islands;
}

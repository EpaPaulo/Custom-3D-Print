// Polygon triangulation by ear clipping, with hole bridging.
//
// The plate's top face is a single outline with one circular hole per stud —
// up to a couple of thousand holes on a large plate — so a naive O(n²) clipper
// is not fast enough. This is the standard ear-clipping algorithm with the two
// optimisations that make it practical at that size: holes are bridged into the
// outer ring so the whole face becomes one simple polygon, and ear candidates
// are tested against a z-order (Morton) curve so each test looks at the handful
// of points that could actually lie inside the ear rather than all of them.
//
// Input is a flat coordinate array plus the start index of each hole, which is
// the shape the geometry builder already produces. Winding is fixed up here:
// the outer ring is walked counter-clockwise and holes clockwise regardless of
// how they came in, so callers never have to think about it.

export function earcut(data, holeIndices, dim = 2, keepCollinear = false) {
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  keepCollinearPoints = keepCollinear;
  let outerNode = linkedList(data, 0, outerLen, dim, true);
  const triangles = [];

  if (!outerNode || outerNode.next === outerNode.prev) return triangles;

  let minX, minY, maxX, maxY, invSize;

  if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);

  // A z-order index only pays for itself once the ring is big; below that the
  // plain quadratic ear test is cheaper than building the curve.
  if (data.length > 80 * dim) {
    minX = maxX = data[0];
    minY = maxY = data[1];
    for (let i = dim; i < outerLen; i += dim) {
      const x = data[i];
      const y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // The curve maps coordinates into a 15-bit integer grid, so it needs the
    // longer side of the bounding box to scale by.
    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 32767 / invSize : 0;
  }

  earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);

  return triangles;
}

// Build a circular doubly linked list from a run of the coordinate array.
function linkedList(data, start, end, dim, clockwise) {
  let last;

  if (clockwise === signedArea(data, start, end, dim) > 0) {
    for (let i = start; i < end; i += dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last);
  } else {
    for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last);
  }

  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }

  return last;
}

// Whether a vertex lying exactly on the line through its neighbours may be
// dropped. It normally may — it adds nothing to the outline. But when the ring
// is a seam that other geometry is sewn to, dropping one leaves the two sides
// disagreeing about where the boundary's vertices are, so the caller can ask
// for every vertex it passed in to survive.
let keepCollinearPoints = false;

// Drop colinear and duplicate points; they produce zero-area ears.
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;

  let p = start;
  let again;
  do {
    again = false;

    if (!p.steiner && (equals(p, p.next) || (!keepCollinearPoints && area(p.prev, p, p.next) === 0))) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);

  return end;
}

// The main loop. `pass` counts the escalating repair strategies used when a
// ring stops yielding ears, which happens on self-touching input.
function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
  if (!ear) return;

  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);

  let stop = ear;

  while (ear.prev !== ear.next) {
    const prev = ear.prev;
    const next = ear.next;

    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);

      removeNode(ear);

      // Skipping the next vertex leads to less sliver triangles.
      ear = next.next;
      stop = next.next;

      continue;
    }

    ear = next;

    if (ear === stop) {
      if (!pass) {
        earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
      } else if (pass === 1) {
        ear = cureLocalIntersections(filterPoints(ear), triangles);
        earcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles, dim, minX, minY, invSize);
      }
      break;
    }
  }
}

function isEar(ear) {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;

  if (area(a, b, c) >= 0) return false; // reflex, can't be an ear

  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);

  let p = c.next;
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) &&
        area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }

  return true;
}

function isEarHashed(ear, minX, minY, invSize) {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;

  if (area(a, b, c) >= 0) return false;

  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);

  // Only points whose z-order value falls inside the ear's bounding box range
  // can be inside the ear, so the search walks outward from the ear in both
  // directions along the sorted curve and stops as soon as it leaves the range.
  const minZ = zOrder(x0, y0, minX, minY, invSize);
  const maxZ = zOrder(x1, y1, minX, minY, invSize);

  let p = ear.prevZ;
  let n = ear.nextZ;

  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;

    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }

  while (p && p.z >= minZ) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
  }

  while (n && n.z <= maxZ) {
    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }

  return true;
}

// Walk the polygon cutting off triangles whose diagonal is valid, which
// resolves rings that touch themselves at a single vertex.
function cureLocalIntersections(start, triangles) {
  let p = start;
  do {
    const a = p.prev;
    const b = p.next.next;

    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);

      removeNode(p);
      removeNode(p.next);

      p = start = b;
    }
    p = p.next;
  } while (p !== start);

  return filterPoints(p);
}

// Last resort: find a diagonal that splits the ring in two and recurse.
function splitEarcut(start, triangles, dim, minX, minY, invSize) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);

        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);

        earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
        earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

// Bridge every hole into the outer ring, leftmost hole first, so that each
// bridge only has to consider the rings already merged.
function eliminateHoles(data, holeIndices, outerNode, dim) {
  const queue = [];

  for (let i = 0, len = holeIndices.length; i < len; i++) {
    const start = holeIndices[i] * dim;
    const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false);
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }

  queue.sort((a, b) => a.x - b.x || a.y - b.y);

  for (let i = 0; i < queue.length; i++) {
    outerNode = eliminateHole(queue[i], outerNode);
  }

  return outerNode;
}

function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;

  const bridgeReverse = splitPolygon(bridge, hole);

  // Cleaning up after a bridge only has to look either side of the two vertices
  // it introduced: nothing else in the ring changed. The textbook version sweeps
  // the whole ring instead, which is what makes a face with thousands of holes —
  // a plate has one per stud — quadratic. Pass 1 of the ear loop still does a
  // full sweep if the local one left anything behind.
  filterAround(bridgeReverse);
  return filterAround(bridge);
}

// Run the collinear/duplicate filter over a short window centred on `node`.
// Returns a node guaranteed to still be in the ring.
function filterAround(node) {
  let start = node;
  let end = node;
  for (let i = 0; i < 3; i++) {
    if (start.prev === end) break;
    start = start.prev;
    if (end.next === start) break;
    end = end.next;
  }
  return filterPoints(start, end);
}

// Cast a ray from the hole's leftmost point towards -x and take the edge it
// hits; the bridge vertex is the endpoint of that edge that is visible from the
// hole, preferring the one with the smallest angle when several qualify.
function findHoleBridge(hole, outerNode) {
  let p = outerNode;
  const hx = hole.x;
  const hy = hole.y;
  let qx = -Infinity;
  let m;

  if (equals(hole, p)) return p;
  do {
    if (equals(hole, p.next)) return p.next;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m; // hole touches the outer ring
      }
    }
    p = p.next;
  } while (p !== outerNode);

  if (!m) return null;

  const stop = m;
  const mx = m.x;
  const my = m.y;
  let tanMin = Infinity;

  p = m;

  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);

      if (locallyInside(p, hole) &&
          (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }

    p = p.next;
  } while (p !== stop);

  return m;
}

// Whether sector `m` lies fully inside sector `p`, used to break ties above.
function sectorContainsSector(m, p) {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function indexCurve(start, minX, minY, invSize) {
  let p = start;
  do {
    if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
    p.prevZ = p.prev;
    p.nextZ = p.next;
    p = p.next;
  } while (p !== start);

  p.prevZ.nextZ = null;
  p.prevZ = null;

  sortLinked(p);
}

// Merge sort on a linked list, in place and without recursion.
function sortLinked(list) {
  let numMerges;
  let inSize = 1;

  do {
    let p = list;
    let e;
    list = null;
    let tail = null;
    numMerges = 0;

    while (p) {
      numMerges++;
      let q = p;
      let pSize = 0;
      for (let i = 0; i < inSize; i++) {
        pSize++;
        q = q.nextZ;
        if (!q) break;
      }
      let qSize = inSize;

      while (pSize > 0 || (qSize > 0 && q)) {
        if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) {
          e = p;
          p = p.nextZ;
          pSize--;
        } else {
          e = q;
          q = q.nextZ;
          qSize--;
        }

        if (tail) tail.nextZ = e;
        else list = e;

        e.prevZ = tail;
        tail = e;
      }

      p = q;
    }

    tail.nextZ = null;
    inSize *= 2;
  } while (numMerges > 1);

  return list;
}

// Morton code of a point, coordinates first mapped into a 15-bit grid.
function zOrder(x, y, minX, minY, invSize) {
  x = (x - minX) * invSize | 0;
  y = (y - minY) * invSize | 0;

  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;

  y = (y | (y << 8)) & 0x00ff00ff;
  y = (y | (y << 4)) & 0x0f0f0f0f;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;

  return x | (y << 1);
}

function getLeftmost(start) {
  let p = start;
  let leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);

  return leftmost;
}

function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
         (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
         (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

// A diagonal is usable when it stays inside the polygon and crosses no edge.
function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
         (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
          (area(a.prev, a, b.prev) || area(a, b.prev, b)) ||
          equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
}

// Signed area of a triangle, doubled. Negative means counter-clockwise.
function area(p, q, r) {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1, p2) {
  return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1, q1, p2, q2) {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));

  if (o1 !== o2 && o3 !== o4) return true; // general case

  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;

  return false;
}

// Whether q lies on segment pr, given the three are already colinear.
function onSegment(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
         q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function sign(num) {
  return num > 0 ? 1 : num < 0 ? -1 : 0;
}

function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
        intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);

  return false;
}

function locallyInside(a, b) {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function middleInside(a, b) {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
        (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);

  return inside;
}

// Cut the ring in two along a-b, returning the second ring. Both rings keep
// their own copies of a and b, which is what makes the bridge watertight.
function splitPolygon(a, b) {
  const a2 = createNode(a.i, a.x, a.y);
  const b2 = createNode(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;

  a2.next = an;
  an.prev = a2;

  b2.next = a2;
  a2.prev = b2;

  bp.next = b2;
  b2.prev = bp;

  return b2;
}

function insertNode(i, x, y, last) {
  const p = createNode(i, x, y);

  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p) {
  p.next.prev = p.prev;
  p.prev.next = p.next;

  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}

function createNode(i, x, y) {
  return {
    i,                 // index in the coordinate array
    x, y,
    prev: null,        // ring neighbours
    next: null,
    z: 0,              // z-order value
    prevZ: null,       // sorted-by-z neighbours
    nextZ: null,
    steiner: false,
  };
}

function signedArea(data, start, end, dim) {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

/**
 * Fraction of the polygon's area the triangulation actually covers, as a
 * number that should be 1. Used by the tests as a cheap end-to-end check that
 * a face came out whole rather than merely plausible.
 */
export function deviation(data, holeIndices, dim, triangles) {
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;

  let polygonArea = Math.abs(signedArea(data, 0, outerLen, dim));
  if (hasHoles) {
    for (let i = 0, len = holeIndices.length; i < len; i++) {
      const start = holeIndices[i] * dim;
      const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
      polygonArea -= Math.abs(signedArea(data, start, end, dim));
    }
  }

  let trianglesArea = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * dim;
    const b = triangles[i + 1] * dim;
    const c = triangles[i + 2] * dim;
    trianglesArea += Math.abs(
      (data[a] - data[c]) * (data[b + 1] - data[a + 1]) -
      (data[a] - data[b]) * (data[c + 1] - data[a + 1]));
  }

  return polygonArea === 0 && trianglesArea === 0 ? 0
    : Math.abs((trianglesArea - polygonArea) / polygonArea);
}

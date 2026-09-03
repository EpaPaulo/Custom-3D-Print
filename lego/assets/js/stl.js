// Binary STL writer.
//
// STL carries no units. Every slicer reads the numbers as millimetres, which is
// what the geometry is built in, so nothing has to be converted on the way out.

export function trianglesToSTL(positions, header = 'lego-compatible plate generator') {
  const triangles = (positions.length / 9) | 0;

  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const head = header.slice(0, 79);
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i) & 0x7f;

  view.setUint32(80, triangles, true);

  let off = 84;
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;

    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;

    // Flat triangles are kept rather than dropped: they are what closes the
    // seam where the tiled interior of the top face meets the border band, and
    // removing them would turn each of those vertices into a T-junction. They
    // have no direction to record, so their normal is written as zero — which
    // the format allows, and which every slicer reads as "take the winding".
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }

    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    view.setFloat32(off + 12, ax, true);
    view.setFloat32(off + 16, ay, true);
    view.setFloat32(off + 20, az, true);
    view.setFloat32(off + 24, bx, true);
    view.setFloat32(off + 28, by, true);
    view.setFloat32(off + 32, bz, true);
    view.setFloat32(off + 36, cx, true);
    view.setFloat32(off + 40, cy, true);
    view.setFloat32(off + 44, cz, true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }

  return { buffer, triangles };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

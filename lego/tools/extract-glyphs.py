#!/usr/bin/env python3
"""
Turn a handful of TrueType faces into the glyph data the generator ships.

The plate generator has to build identical geometry in the browser and on the
server, so it cannot depend on a font being installed, or on a rasteriser, in
either place. This reads the `glyf` outlines for A-Z and 0-9 once, here, and
writes them out as a plain data module: control points in a 1000-unit em, which
the generator flattens at whatever contour quality it was asked for.

Run it only to add or replace a face. The output is committed; nothing at
runtime needs a .ttf.

    python3 lego/tools/extract-glyphs.py > lego/assets/js/glyphs.js
"""

import struct
import sys

CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

# The faces on offer. Bold everywhere on purpose: a plate is only useful where
# a stud fits, and a regular weight's stems come out too thin to hold one.
FACES = [
    ('sans', 'Sem serifa', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
    ('serif', 'Serifada', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'),
    ('mono', 'Monoespaçada', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'),
]


class TrueType:
    def __init__(self, path):
        self.data = open(path, 'rb').read()
        num_tables = struct.unpack_from('>H', self.data, 4)[0]
        self.tables = {}
        for i in range(num_tables):
            off = 12 + i * 16
            tag = self.data[off:off + 4].decode('latin-1')
            start, length = struct.unpack_from('>II', self.data, off + 8)
            self.tables[tag] = (start, length)

        head = self.tables['head'][0]
        self.units_per_em = struct.unpack_from('>H', self.data, head + 18)[0]
        self.long_loca = struct.unpack_from('>h', self.data, head + 50)[0] == 1
        self.num_glyphs = struct.unpack_from('>H', self.tables['maxp'][0] + 4, )[0] \
            if False else struct.unpack_from('>H', self.data, self.tables['maxp'][0] + 4)[0]
        self.cmap = self._read_cmap()

    def _read_cmap(self):
        base = self.tables['cmap'][0]
        count = struct.unpack_from('>H', self.data, base + 2)[0]
        best = None
        for i in range(count):
            plat, enc, off = struct.unpack_from('>HHI', self.data, base + 4 + i * 8)
            fmt = struct.unpack_from('>H', self.data, base + off)[0]
            # Format 4 on a Unicode or Windows subtable covers everything here.
            if fmt == 4 and (plat == 3 and enc in (1, 10) or plat == 0):
                best = base + off
                break
        if best is None:
            raise SystemExit('no usable cmap subtable')

        seg_x2 = struct.unpack_from('>H', self.data, best + 6)[0]
        segs = seg_x2 // 2
        ends = struct.unpack_from('>%dH' % segs, self.data, best + 14)
        starts = struct.unpack_from('>%dH' % segs, self.data, best + 16 + seg_x2)
        deltas = struct.unpack_from('>%dh' % segs, self.data, best + 16 + seg_x2 * 2)
        range_off_pos = best + 16 + seg_x2 * 3
        range_offs = struct.unpack_from('>%dH' % segs, self.data, range_off_pos)

        table = {}
        for i in range(segs):
            for code in range(starts[i], min(ends[i], 0xFFFF) + 1):
                if range_offs[i] == 0:
                    gid = (code + deltas[i]) & 0xFFFF
                else:
                    addr = range_off_pos + i * 2 + range_offs[i] + (code - starts[i]) * 2
                    gid = struct.unpack_from('>H', self.data, addr)[0]
                    if gid:
                        gid = (gid + deltas[i]) & 0xFFFF
                if gid:
                    table[code] = gid
        return table

    def glyph_range(self, gid):
        loca = self.tables['loca'][0]
        if self.long_loca:
            a, b = struct.unpack_from('>II', self.data, loca + gid * 4)
        else:
            a, b = struct.unpack_from('>HH', self.data, loca + gid * 2)
            a, b = a * 2, b * 2
        return a, b

    def contours(self, gid, depth=0):
        """Contours as lists of (x, y, on_curve), in font units."""
        if depth > 4:
            return []
        start, end = self.glyph_range(gid)
        if end <= start:
            return []
        base = self.tables['glyf'][0] + start
        n = struct.unpack_from('>h', self.data, base)[0]

        if n < 0:
            return self._composite(base + 10, depth)

        ends = struct.unpack_from('>%dH' % n, self.data, base + 10)
        total = ends[-1] + 1 if n else 0
        pos = base + 10 + n * 2
        instr = struct.unpack_from('>H', self.data, pos)[0]
        pos += 2 + instr

        flags = []
        while len(flags) < total:
            f = self.data[pos]
            pos += 1
            flags.append(f)
            if f & 8:                      # repeat
                r = self.data[pos]
                pos += 1
                flags.extend([f] * r)
        flags = flags[:total]

        xs, v = [], 0
        for f in flags:
            if f & 2:
                d = self.data[pos]
                pos += 1
                v += d if f & 16 else -d
            elif not f & 16:
                v += struct.unpack_from('>h', self.data, pos)[0]
                pos += 2
            xs.append(v)

        ys, v = [], 0
        for f in flags:
            if f & 4:
                d = self.data[pos]
                pos += 1
                v += d if f & 32 else -d
            elif not f & 32:
                v += struct.unpack_from('>h', self.data, pos)[0]
                pos += 2
            ys.append(v)

        out, first = [], 0
        for e in ends:
            out.append([(xs[i], ys[i], bool(flags[i] & 1)) for i in range(first, e + 1)])
            first = e + 1
        return out

    def _composite(self, pos, depth):
        out = []
        while True:
            flags, index = struct.unpack_from('>HH', self.data, pos)
            pos += 4
            if flags & 1:                  # ARG_1_AND_2_ARE_WORDS
                a1, a2 = struct.unpack_from('>hh', self.data, pos)
                pos += 4
            else:
                a1, a2 = struct.unpack_from('>bb', self.data, pos)
                pos += 2
            sx = sy = 1.0
            s01 = s10 = 0.0
            if flags & 8:                  # WE_HAVE_A_SCALE
                sx = sy = f2dot14(self.data, pos)
                pos += 2
            elif flags & 0x40:             # X_AND_Y_SCALE
                sx = f2dot14(self.data, pos)
                sy = f2dot14(self.data, pos + 2)
                pos += 4
            elif flags & 0x80:             # TWO_BY_TWO
                sx = f2dot14(self.data, pos)
                s01 = f2dot14(self.data, pos + 2)
                s10 = f2dot14(self.data, pos + 4)
                sy = f2dot14(self.data, pos + 6)
                pos += 8
            dx, dy = (a1, a2) if flags & 2 else (0, 0)
            for c in self.contours(index, depth + 1):
                out.append([(x * sx + y * s10 + dx, x * s01 + y * sy + dy, on) for x, y, on in c])
            if not flags & 0x20:           # MORE_COMPONENTS
                break
        return out


def f2dot14(data, pos):
    return struct.unpack_from('>h', data, pos)[0] / 16384.0


# Flatten a quadratic contour just far enough to measure it. The generator does
# its own flattening at print quality; this is only for the bounding box, which
# it needs before it builds anything in order to size the plate.
def flatten(contour, steps=8):
    pts = []
    n = len(contour)
    if not n:
        return pts

    # TrueType leaves the on-curve point between two control points implied.
    expanded = []
    for i in range(n):
        x, y, on = contour[i]
        px, py, pon = contour[i - 1]
        if not on and not pon:
            expanded.append(((x + px) / 2.0, (y + py) / 2.0, True))
        expanded.append((x, y, on))

    start = next((i for i, p in enumerate(expanded) if p[2]), None)
    if start is None:
        return pts
    m = len(expanded)
    order = [expanded[(start + i) % m] for i in range(m)]
    order.append(order[0])

    cur = order[0]
    pts.append((cur[0], cur[1]))
    i = 1
    while i < len(order):
        p = order[i]
        if p[2]:
            pts.append((p[0], p[1]))
            cur = p
            i += 1
        else:
            nxt = order[i + 1]
            for s in range(1, steps + 1):
                t = s / steps
                u = 1 - t
                pts.append((
                    u * u * cur[0] + 2 * u * t * p[0] + t * t * nxt[0],
                    u * u * cur[1] + 2 * u * t * p[1] + t * t * nxt[1],
                ))
            cur = nxt
            i += 2
    return pts


def main():
    faces = []
    for fid, label, path in FACES:
        font = TrueType(path)
        k = 1000.0 / font.units_per_em          # one em is 1000 units, whatever the face used
        glyphs = {}
        for ch in CHARS:
            gid = font.cmap.get(ord(ch))
            if not gid:
                raise SystemExit('%s has no glyph for %s' % (path, ch))
            contours = font.contours(gid)
            if not contours:
                raise SystemExit('%s has an empty glyph for %s' % (path, ch))

            scaled = [[(round(x * k), round(y * k), on) for x, y, on in c] for c in contours]
            flat = [p for c in scaled for p in flatten(c)]
            xs = [p[0] for p in flat]
            ys = [p[1] for p in flat]
            glyphs[ch] = {
                'c': [[v for p in c for v in (p[0], p[1], 1 if p[2] else 0)] for c in scaled],
                'b': [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
            }
        faces.append((fid, label, glyphs))

    out = sys.stdout
    out.write('''// Glyph outlines for the letter and number plates. GENERATED — do not edit.
//
// Regenerate with:
//     python3 lego/tools/extract-glyphs.py > lego/assets/js/glyphs.js
//
// Why the outlines are committed rather than read from a font at runtime: the
// generator has to build identical geometry in the browser and on the server,
// and neither place can be made to agree about which fonts are installed. A
// letter that previewed in one face and printed in another would be a refund.
//
// Each glyph is a list of contours in TrueType's quadratic form, on a 1000-unit
// em: [x, y, onCurve, ...]. Off-curve points are control points, and two of
// them in a row imply an on-curve point half way between, which is the format's
// own shorthand. `b` is the glyph's bounding box, which the generator needs
// before it builds anything in order to work out how wide the plate must be.
//
// Derived from the DejaVu fonts (dejavu-fonts.github.io), which are free to use
// and modify; see lego/assets/fonts/LICENCE.md for the notice that comes with
// them. The faces are labelled generically here because this is a modified
// subset, not the fonts themselves.

''')
    out.write('export const FONTS = [\n')
    for fid, label, glyphs in faces:
        out.write("  {\n    id: '%s',\n    label: '%s',\n    glyphs: {\n" % (fid, label))
        for ch in CHARS:
            g = glyphs[ch]
            contours = ','.join('[' + ','.join(str(v) for v in c) + ']' for c in g['c'])
            out.write("      %s: { b: [%s], c: [%s] },\n"
                      % (ch if ch.isalpha() else "'%s'" % ch,
                         ','.join(str(v) for v in g['b']), contours))
        out.write('    },\n  },\n')
    out.write('];\n\nexport const CHARACTERS = %r;\n' % CHARS)
    out.write("export const fontById = (id) => FONTS.find((f) => f.id === id);\n")


main()

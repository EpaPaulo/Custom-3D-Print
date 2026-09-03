# Personalizador de Capa Bimby TM7

A browser app for personalising a 3D-printable **Thermomix TM7 display cover**.
Add text and images, see them on the cover in a live 3D preview, then download
the two print-ready STLs.

The cover prints **black** and the design prints **white**, flush with the
surface. There is no relief: the colour change happens in the first few layers,
so the two filaments meet level with each other.

Everything runs client-side — no server, no build step, no upload of your
images anywhere. Drop it on GitHub Pages and it works.

## Using it

1. **Modelo base** — which model you are personalising.
   - *Capa do ecrã TM7* (default) — `assets/model/tm7-cover.stl`,
     253.4 × 172.4 × 10 mm, personalised on its flat rectangular face.
     Usable area 236 × 155 mm.
   - *Base TM7 — disco* — `assets/model/tm7-base.stl`, Ø 205.9 × 30.1 mm,
     personalised on its flat round face. Usable area Ø 202 mm.
   - *Medidas próprias* — the parametric generator, for any size you like.

   A supplied model's dimensions are what make it fit the machine, so they are
   not adjustable and the mesh is never modified. Models are fetched only when
   picked and kept afterwards, so switching back is instant. `?model=<id>`
   (`cover` or `base`) opens on a given one; otherwise the app reopens whatever
   you used last.
2. **Cor** — how deep the white runs into the cover, in millimetres. 0.6 mm is
   three layers at 0.2 mm, which is plenty for full opacity. Contour quality
   trades file size for how smooth the letter edges come out.
3. **Camadas** — add text or image layers, then position, scale and rotate
   each one. Layers stack in list order.
4. **Two STLs** — the cover and the design, both in millimetres.

Your design is kept in `localStorage`, so a refresh won't lose it.

### Printing the two files

STL carries no notion of parts or colour, so the two bodies have to stay two
files — merged into one they would print in a single colour. In the slicer,
load both as *one object with two parts*: they share a coordinate system, so
they land aligned, and you then assign a filament to each.

The design body's surface sits exactly on the cover's face and runs inward, so
it occupies the cover rather than sitting on it. Print face-down and the colour
change happens in the first few layers.

### How the template stays intact

The template's 8,044 triangle records are copied into the cover export byte for
byte, normals and all. Nothing is re-tessellated, re-normalised or repaired, and
the design never crosses the face plane outward — so what you print is
dimensionally the file you supplied.

### Finding the face, and the room on it

Both models are personalised on their lowest Z plane — the one carrying
downward-facing triangles. How much of it is usable follows from the outline:

- **Rectangular face.** The full face, inset far enough at each side to clear
  the corner arcs — r(1 − 1/√2) plus 2 mm. On the cover's 23.2 mm radius that
  gives 236 × 155 mm.
- **Round face.** A disc is the limiting case of a rounded rectangle: its
  corner radius reaches half its own width, which is how the app recognises
  one. Confining a design to the square inscribed in a disc would throw away a
  third of the room, so the whole circle is offered instead — Ø 202 mm on the
  base — and the design is cut to that circle as it is built. Layers are still
  positioned in a square box around it; anything outside the circle is dropped
  rather than allowed to run off the face.

The cut lands where the contour crosses it, so it can sit up to half a grid
cell outside the nominal radius. The 2 mm margin covers that with room to
spare.

Engraving is offered only in *medidas próprias*, because removing material
would mean cutting into the template mesh rather than adding to it.

### About the supplied cover template

Worth knowing, though it is left exactly as-is:

- It contains **two separate bodies** — the cover, plus a 192 × 134.1 × 3 mm
  box sitting wholly inside the cover's own plate. The box adds nothing to the
  union; it is redundant rather than harmful.
- It carries **31 degenerate (zero-area) triangles** and **90 non-manifold
  edges**, including a zero-thickness internal sheet at z = 1. It is closed
  (no open edges) and slices fine.

The export inherits exactly these counts and adds none of its own. The same
holds for the base: its 60,702 records are copied through byte for byte.

### Images

PNG and SVG with transparency work best: the alpha channel becomes the shape.
For opaque images (photos, black-on-white logos) untick *Usar transparência*
and use the *Limiar* slider to pick where dark turns into stamped material.
Images are reduced to a two-tone silhouette — this makes a stamp, not a relief.

## Printing notes

- The model is exported in millimetres and sits flat on Z = 0, ready to slice.
- Print the cover face-down on the bed: that puts the design in the first
  layers, where the colour change belongs.
- Colour depth is capped at the cover's own thickness — the second filament
  cannot run all the way through. The app says so when it clamps your setting.
- A 0.4 mm nozzle resolves white-on-black text down to roughly 6–8 mm cap
  height. Below that the two colours start to bleed into each other.
- The app measures the design against that limit and says so before you print.
  It reports two different failures: a whole element too small to survive
  (found as the narrowest connected piece) and a hairline stroke inside an
  otherwise healthy shape (found by opening the mask and seeing what does not
  come back). An opening rounds convex corners, so every shape sheds a little
  ink however healthy it is; only connected runs above a real area are counted,
  which is why a clean 1.5 mm bar measures a flat zero.

## How the geometry works

Text and images are rasterised to a grayscale mask, which is box-filtered
through a summed-area table so the grid samples it without aliasing.

The design body comes from **marching triangles** over that mask. The marching
*squares* case has an ambiguous saddle whose two readings differ, and the wrong
reading joins letterforms that should stay apart; splitting each cell into two
triangles removes the ambiguity, and every region it produces is convex, so a
fan triangulation of it is always valid. Walls are emitted only along the
contour itself — never along a cell edge shared with a neighbour — which is what
keeps the result closed.

**Model mode** locates the outward face automatically: the lowest Z plane
carrying downward triangles, round or rectangular. Layer coordinates are the face as you look at it;
since that face's normal points along −Z, mapping to world space mirrors X, and
a reflection reverses winding, so every triangle is emitted with two vertices
swapped to keep it facing outward.

**Parametric mode** builds the cover as a **Coons patch** over a rounded
rectangle, so the quad grid conforms exactly to the outline instead of being
clipped to it. No CSG library is involved in either mode.

Mesh integrity is checked by matching every directed edge with its reverse and
confirming the signed volume is positive. Zero non-manifold edges is only
achievable when the shape itself is manifold: regions that touch at a single
point share a vertical edge once the design has thickness, and four faces meet
there by construction.

## The shop

`store/` is a storefront around this configurator: seven niches (Bimby, LEGO,
gaming, animals, kitchen & WC, drones, ergonomics), a catalogue, product pages,
a cart and a stub checkout. The Bimby and LEGO products are personalised — their
buy button stays disabled until the customer has designed the part, and pressing
*Personalizar* opens this configurator in `?shop=1` mode (or the brick-plate
generator) over the page.

It is static, needs no backend, and is served alongside this app:
<http://localhost:8099/store/>. See `store/README.md`.

## Layout

```
index.html                    markup + import map
assets/css/style.css
assets/js/geom.js             rounded rect, Coons patch, mesh assembly
assets/js/template.js         STL parsing, face detection, design inlay
assets/js/stamp.js            text/image layers -> grayscale mask
assets/js/stl.js              binary STL writer
assets/js/app.js              viewer, UI, model registry, export
assets/model/tm7-cover.stl    the TM7 display cover, unmodified
assets/model/tm7-base.stl     the round TM7 base, unmodified
tools/build-artifact.mjs      single-file build for publishing
vendor/                       three.js r160 (vendored, no CDN)
```

`geom.js`, `template.js` and `stl.js` have no DOM dependencies and run
unchanged under Node, so STLs can be generated server-side from stored design
parameters.

## Single-file build

`npm run artifact` bundles the whole thing into one self-contained HTML file
under `dist/` — three.js, the app, the stylesheet and every model STL all
inlined, no external requests at all. It is what gets published as a Claude
Artifact, and it also works straight from `file://`.

Nothing in `assets/` changes to make that build work; the two differences live
in `tools/build-artifact.mjs`. `fetch` is shimmed to answer model requests
from the embedded copies (decoded only when a model is picked, so opening the
page pays only for the one it starts on), and the STL buttons are hidden
because the
artifact viewer's save allowlist has no `.stl` entry — it offers the preview
PNG instead. The build fails rather than publishing if the page ends up
referencing another origin, since the artifact CSP would block it.

esbuild is the only dependency, and only for this; the site itself still has
no build step.

## Running locally

Any static file server works; ES modules need a real origin:

```sh
python3 -m http.server 8099
```

Then open <http://localhost:8099/>.

## Publishing to GitHub Pages

**Settings → Pages → Source: _Deploy from a branch_ → `main` → `/ (root)` → Save.**

The site is then served at `https://epapaulo.github.io/Custom-3D-Print/`, and every
push to `main` republishes it. There is no build step, so no workflow is
needed; `.nojekyll` is present so the asset folders are served untouched.

Turning Pages on has to be done from the web UI — the Actions `GITHUB_TOKEN`
is not permitted to create a Pages site, so it cannot be automated from
inside the repository.

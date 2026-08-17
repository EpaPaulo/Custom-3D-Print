# Personalizador de Capa Bimby TM7

A browser app for personalising a 3D-printable **Thermomix TM7 display cover**.
Add text and images, see the result stamped on the cover in a live 3D preview,
then download a print-ready STL.

Everything runs client-side — no server, no build step, no upload of your
images anywhere. Drop it on GitHub Pages and it works.

## Using it

1. **Modelo base**
   - *Template TM7* (default) — the supplied `assets/model/tm7-cover.stl`,
     253.4 × 172.4 × 10 mm. Its dimensions are what make it fit the machine, so
     they are not adjustable and the mesh is never modified.
   - *Medidas próprias* — the parametric generator, for any size you like.
2. **Relevo** — how tall the design stands proud of the cover. In *medidas
   próprias* you can also engrave. Mesh quality trades file size for detail.
3. **Camadas** — add text or image layers, then position, scale and rotate
   each one. Layers stack in list order.
4. **Descarregar STL** — writes a binary STL in millimetres.

Your design is kept in `localStorage`, so a refresh won't lose it.

### How the template stays intact

The design is emitted as a **separate closed solid** laid on the cover's
outward face, overlapping it by 0.6 mm. Every slicer unions overlapping bodies
on import, so it prints as one part — while the template's 8,044 triangle
records are copied into the export byte for byte, normals and all. Nothing is
re-tessellated, re-normalised or repaired, so what you print is dimensionally
the file you supplied.

The usable design area is 236 × 155 mm: the full face inset far enough to clear
its 23.2 mm corner radius.

Engraving is offered only in *medidas próprias*, because removing material
would mean cutting into the template mesh rather than adding to it.

### About the supplied template

Worth knowing, though it is left exactly as-is:

- It contains **two separate bodies** — the cover, plus a 192 × 134.1 × 3 mm
  box sitting wholly inside the cover's own plate. The box adds nothing to the
  union; it is redundant rather than harmful.
- It carries **31 degenerate (zero-area) triangles** and **90 non-manifold
  edges**, including a zero-thickness internal sheet at z = 1. It is closed
  (no open edges) and slices fine.

The export inherits exactly these counts and adds none of its own.

### Images

PNG and SVG with transparency work best: the alpha channel becomes the shape.
For opaque images (photos, black-on-white logos) untick *Usar transparência*
and use the *Limiar* slider to pick where dark turns into stamped material.
Images are reduced to a two-tone silhouette — this makes a stamp, not a relief.

## Printing notes

- The model is exported in millimetres and sits flat on Z = 0, ready to slice.
- Print the cover face-down on the bed for the cleanest stamped surface.
- Engraved depth is capped at `wall thickness − 0.4 mm` so there is always
  material under the design; the app tells you when it clamps your setting.
- A 0.4 mm nozzle resolves raised text down to roughly 8–10 mm cap height.
  Below that, prefer engraved.

## How the geometry works

Text and images are rasterised to a grayscale mask, which is box-filtered
through a summed-area table so the grid samples it without aliasing.

**Template mode** locates the outward face automatically — the lowest Z plane
carrying downward triangles — and builds the design as a closed slab over it.
Layer coordinates are the face as you look at it; since that face's normal
points along −Z, mapping to world space mirrors X, and a reflection reverses
winding, so every triangle is emitted with two vertices swapped to keep it
facing outward.

**Parametric mode** builds the stamped face as a **Coons patch** over a rounded
rectangle, so the quad grid conforms exactly to the outline instead of being
clipped to it, then displaces every vertex along Z. Walls are sewn to the
*displaced* boundary ring, so a design may run right off the edge without
opening a hole. No CSG library is involved in either mode.

Mesh integrity is checked by matching every directed edge with its reverse and
confirming the signed volume is positive.

## Layout

```
index.html                    markup + import map
assets/css/style.css
assets/js/geom.js             rounded rect, Coons patch, mesh assembly
assets/js/template.js         STL parsing, face detection, stamp slab
assets/js/stamp.js            text/image layers -> grayscale mask
assets/js/stl.js              binary STL writer
assets/js/app.js              viewer, UI, export
assets/model/tm7-cover.stl    the supplied template, unmodified
tools/build-artifact.mjs      single-file build for publishing
vendor/                       three.js r160 (vendored, no CDN)
```

`geom.js`, `template.js` and `stl.js` have no DOM dependencies and run
unchanged under Node, so STLs can be generated server-side from stored design
parameters.

## Single-file build

`npm run artifact` bundles the whole thing into one self-contained HTML file
under `dist/` — three.js, the app, the stylesheet and the template STL all
inlined, no external requests at all. It is what gets published as a Claude
Artifact, and it also works straight from `file://`.

Nothing in `assets/` changes to make that build work; the two differences live
in `tools/build-artifact.mjs`. `fetch` is shimmed to answer the template
request from the embedded copy, and the STL buttons are hidden because the
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

The site is then served at `https://epapaulo.github.io/epa_site/`, and every
push to `main` republishes it. There is no build step, so no workflow is
needed; `.nojekyll` is present so the asset folders are served untouched.

Turning Pages on has to be done from the web UI — the Actions `GITHUB_TOKEN`
is not permitted to create a Pages site, so it cannot be automated from
inside the repository.

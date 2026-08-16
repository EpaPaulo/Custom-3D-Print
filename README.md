# Personalizador de Capa Bimby TM7

A browser app for personalising a 3D-printable **Thermomix TM7 display cover**.
Add text and images, see the result stamped on the cover in a live 3D preview,
then download a print-ready STL.

Everything runs client-side — no server, no build step, no upload of your
images anywhere. Drop it on GitHub Pages and it works.

## Using it

1. **Capa** — set the outer size, corner radius, wall thickness and, for the
   shell style, how deep the lip is. Defaults are sized for the TM7's 10-inch
   screen (230 × 150 mm); measure your machine and adjust.
   - *Com rebordo* — a shallow shell with a lip that sits over the screen.
   - *Placa lisa* — a flat solid plate.
2. **Relevo** — choose raised or engraved, and how tall/deep the stamp is.
   Mesh quality trades file size against fine detail.
3. **Camadas** — add text or image layers, then position, scale and rotate
   each one. Layers stack in list order.
4. **Descarregar STL** — writes a binary STL in millimetres.

Your design is kept in `localStorage`, so a refresh won't lose it.

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

The stamped face is a **Coons patch** over a rounded rectangle, so the quad
grid conforms exactly to the outline instead of being clipped to it. Text and
images are rasterised to a grayscale mask, which is box-filtered through a
summed-area table and used to displace every vertex of that face along Z.

Walls are sewn to the *displaced* boundary ring, so a design may run right off
the edge of the cover without opening a hole in the mesh. The result is a
closed, consistently-oriented solid — no CSG library involved.

Mesh integrity is checked by matching every directed edge with its reverse and
confirming the signed volume is positive.

## Layout

```
index.html              markup + import map
assets/css/style.css
assets/js/geom.js       rounded rect, Coons patch, mesh assembly
assets/js/stamp.js      text/image layers -> grayscale mask
assets/js/stl.js        binary STL writer
assets/js/app.js        viewer, UI, export
vendor/                 three.js r160 (vendored, no CDN)
```

## Running locally

Any static file server works; ES modules need a real origin:

```sh
python3 -m http.server 8099
```

Then open <http://localhost:8099/>.

## Publishing to GitHub Pages

`.github/workflows/pages.yml` deploys the repo root on every push to `main`,
and can also be run by hand from the Actions tab. It calls
`actions/configure-pages` with `enablement: true`, so the first run switches
Pages on by itself — there is nothing to set in repository settings.

`main` must be the repository's default branch, otherwise the `github-pages`
environment will refuse the deployment.

`.nojekyll` is present so the asset folders are served untouched.

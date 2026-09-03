# Gerador de Placas — compatíveis LEGO

A browser app for generating **3D-printable baseplates compatible with LEGO**.
Pick a shape, set the size in studs, see it in a live 3D preview, then download
a print-ready STL.

It is a separate app from the Bimby cover personaliser in this repository: its
own page, its own geometry, its own backend. The only thing the two share is the
vendored copy of three.js at `../vendor/`.

```
lego/
├── index.html          the configurator
├── assets/js/          geometry and UI, no build step
├── assets/fonts/       the notice for the fonts the letters come from
├── tools/              one-off generator for the glyph data
├── server/             order backend (Express)
└── storefront/         Shopify bridge and a demo product page
```

The front end runs entirely client-side — no server, no build step, nothing
uploaded. Drop it on GitHub Pages and it works. The backend is only needed to
sell plates.

## Where the dimensions come from

The generator was derived from a supplied 28 × 25 baseplate mesh. Dividing its
measurements by its print scale gives round numbers, which are the ones the app
uses as nominal:

| | nominal | the reference plate, at +1 % |
|---|---|---|
| stud pitch | 8.00 mm | 8.08 mm |
| stud diameter | 4.85 mm | 4.90 mm |
| stud height | 1.80 mm | 1.818 mm |
| plate thickness | 1.30 mm | 1.313 mm |
| side clearance | 0.20 mm | 0.202 mm |

A run of *n* studs measures `n × pitch − clearance`, so 28 × 25 comes to
226.038 × 201.798 mm and the whole plate stands 3.131 mm tall — which is the
supplied mesh to the micron. Setting the app to 28 × 25 at +1 % reproduces it.

**The +1 % matters.** Printed at exactly nominal, FDM studs come out slightly
oversized and grip too hard; +1 % is what the reference plate is printed at and
is the right place to start. Adjust it if your first plate is tight or loose —
it is the one setting worth calibrating.

## Using it

1. **Forma** — geometric: rectangle, circle or ellipse, regular polygon, star,
   cross, L, heart. Figures: Santa, bunny, candy cane, pumpkin, ghost. The
   outline is analytic, not snapped to the grid, so a round plate is actually
   round rather than stepped.

   Picking a shape also starts the two size sliders at the proportions it was
   drawn in. Every outline is stretched to fill whatever width and depth you
   then ask for — you buy a plate in studs, not in proportions — but a candy
   cane stretched to a square reads as nothing at all, so it is worth starting
   somewhere sensible.

   The figures are each a **single closed outline with no holes**, which is a
   constraint rather than a style: the plate is one solid, so the ghost has no
   cut-out eyes and the pumpkin has no carved face. Whatever makes the figure
   recognisable has to live in its silhouette. Adding one is a pen path in
   `assets/js/shapes.js` and a line in the `SHAPES` list — the picker's icons
   are drawn from the outlines themselves, so there is no second copy of the
   drawing to keep in step.

   **Letters and numbers** are their own shape: type one character, pick a face,
   and the plate is that character. See below.
2. **Dimensões** — width and depth in studs. A stud is kept only where the whole
   stud fits inside the outline, so nothing ever hangs over the edge. Pick your
   printer under *Área de impressão* and the app says when a plate stops fitting.
3. **Pinos** — LEGO or Duplo spacing, the fit adjustment, all-studs / border /
   chequerboard / none, and hollow studs.

   The pitch, the stud and the side clearance are **not adjustable**, by design.
   They are what compatibility *is*: alter any of them and the plate is still a
   plate, but nothing clicks onto it. They come from the chosen system, and a
   spec that carries its own — from an API caller, or stored by an older build
   that let them be edited — is ignored rather than obeyed, so an old bad value
   heals the next time the plate is built. To make studs grip more or less, use
   the fit adjustment, which is the knob for it.

   Plate thickness is the exception and sits with the other dimensions: a
   thicker plate is stiffer and a thinner one cheaper, and a brick fits either
   way.
4. **Descarregar STL** — millimetres, ready for the slicer.

Your settings are kept in `localStorage`, so a refresh won't lose them.

### Letters and numbers

Pick *Letra / número*, type a character and choose a face. The preview updates
as you type, and the button in the picker shows the character you are on.

- **A–Z and 0–9 only**, upper case. Lowercase is accepted and upper-cased for
  you — it is not a rendering choice being refused. An "i" is a stem and a
  separate dot, and a plate that arrives in two pieces is not a plate.
- **Only the height is yours to set.** A letter's width comes from the letter:
  an M is wide, an I is not. Stretch one to a width someone picked off a slider
  and it stops being that letter, so the app works the width back from the
  glyph and tells you what it came to.
- **Counters are real holes.** The middle of an O, both halves of an 8, the
  triangle in an A — they go all the way through, and studs keep their distance
  from their edges the same way they do from the outside edge.
- Three faces, all bold. That is not a style decision either: a plate is only
  useful where a stud fits, and a regular weight's stems come out too thin to
  hold one.

Two consequences worth knowing before you print. A narrow character carries
few studs — an I at 20 studs tall is 5 wide — so go taller if you want more to
build on. And the monospaced zero is drawn with a dot inside its counter; that
dot is an island of material with nothing joining it to the rest, so it is
dropped and the zero comes out undotted rather than in two pieces.

### Printing

Studs up, no supports, no raft. The first layer is what decides whether the
plate fits: over-squished studs are the usual cause of a plate that grips too
hard. 0.2 mm layers put nine of them in the 1.8 mm stud.

Hollow studs save filament and give the brick above something to flex against,
which many people prefer on printed plates. They are off by default because
solid studs are what the reference plate has.

## Where the glyphs come from

`assets/js/glyphs.js` is generated, and committed. It holds the outlines for
A–Z and 0–9 in three faces as TrueType quadratics on a 1000-unit em, about 29 kB
in total, extracted from the DejaVu fonts by `tools/extract-glyphs.py`.

Nothing reads a font file at runtime, which is the point. The browser previews a
plate and the backend builds the file that gets printed, and the two have to
produce identical geometry; they cannot be made to agree about which fonts are
installed, and a letter that previewed in one face and printed in another would
be a refund. Rasterising and tracing would have the same problem, and would put
a canvas in the server's dependencies to boot.

Regenerate with `python3 lego/tools/extract-glyphs.py > lego/assets/js/glyphs.js`,
which needs the .ttf files present. See `assets/fonts/LICENCE.md` for the notice
that comes with them.

## The slicer

`assets/js/slice.js` is a slicer — enough of one to price a print, which is a
smaller job than making one. It works on the triangles, not on the plate's
parameters, so it keeps working when the geometry changes.

For each layer it cuts the mesh at that height, fills the cross-section onto a
grid one extrusion wide per cell, and then decides what each cell of material
is:

- **perimeter**, if it is within the wall count of the edge — found by eroding
  the filled region a cell at a time, which is exactly what laying a perimeter
  down does;
- **solid skin**, if there is air within the top or bottom layer count above or
  below it, which is what makes the top of a plate solid and its middle hollow;
- **sparse infill** otherwise, counted at the infill fraction.

Extruded volume follows from that directly, weight from the filament's density,
and time from the path length each feature implies at the speed it is printed.

What it does **not** do is plan toolpaths, so two things are estimated rather
than measured. Travel is taken from how many separate islands a layer has —
which matters more than it sounds, because a baseplate's top layers are hundreds
of little circles and the head spends real time hopping between them. And
nothing prints at its nominal speed, so `SPEED_FACTOR` scales the whole thing;
it is the first number to adjust if quotes come out short.

The check that it is right is in the tests: the volume its layers add up to has
to match the mesh's own volume, within a few percent. Everything downstream of
that is arithmetic.

## How the mesh is built

The plate comes out **closed**: a bottom face, a side wall, a top face with one
circular hole per stud, and a cylinder sewn into each hole. Nothing overlaps and
nothing is left open, so a slicer takes the file at face value instead of having
to union intersecting bodies first. `server/test/smoke.mjs` checks it, on every
shape and every stud pattern, by the property that matters: every directed edge
in the mesh has exactly one opposite.

The figures exercise that harder than the geometric shapes do: a candy cane's
hook and a bunny's ears are narrow enough that the interior tiling below falls
back to triangulating the whole face, and the ghost's hem puts a concave notch
between two runs of studs. The letters go further still — they are the only
shapes with holes in them, so they are the check that the counter of an O is a
hole all the way through rather than a hole in the top with a lid underneath.

A shape is a set of rings: one outer, wound counter-clockwise, and one wound
clockwise for each opening. The same wall code walks all of them, because
winding the holes the other way round makes "the material is on the left" true
everywhere, and the wall's normal then comes out pointing away from the plate in
both cases — outward at the edge, inward into the hole.

Which contours of a glyph are holes is decided by their winding, not by their
size. A font says so itself by winding openings against the letter, and going by
size instead gets a monospaced zero wrong.

Two things in `assets/js/plate.js` are worth knowing about before changing it.

**The top face is built in two halves.** Handing the whole thing to a
triangulator as one outline with a hole per stud is correct but quadratic in the
hole count, and a bed-sized plate has a couple of thousand studs — a 52 × 52
plate took 24 seconds that way. So every grid cell lying wholly inside the
outline is sewn directly, cell by cell, and only the border band left over goes
to the triangulator, carrying the few studs whose cells hang over the edge. Same
mesh, 124 ms. Plates whose interior is not a simple region fall back to
triangulating the whole face.

**Flat triangles are kept, not dropped.** Where the tiled interior meets the
border band, the band's boundary carries vertices that sit mid-way along an
otherwise straight run. The triangulator is told to preserve them, and the only
triangle that can consume such a vertex is a flat one. Those triangles are what
stitch the seam: drop them and each of those vertices becomes a T-junction,
which is the classic way a mesh that looks closed still slices with a hairline
crack in it. They carry no area, and every slicer discards them on load.

## The order backend

`server/` is an Express app for selling plates: it records orders from a Shopify
webhook, keeps each customer's design, and builds the print file on demand.

It **imports the same geometry module the browser previews with**
(`../assets/js/plate.js`). That is the point of it: a plate that previewed at
226 mm and printed at 224 would be a refund, and the only way to be sure the two
agree is for there to be one of them. A customer sends a *spec* — a shape and a
few dozen millimetres — never a mesh, so nobody can hand this server arbitrary
triangles to put on a printer.

```
cd lego/server
npm install
cp .env.example .env      # then fill in ADMIN_TOKEN and SHOPIFY_WEBHOOK_SECRET
npm start                 # :3100
npm test                  # 21 checks, no mocks
```

It refuses to start without both secrets — an unsigned webhook is not an order,
and an unguarded print file is the product given away.

### API

| | |
|---|---|
| `GET /api/health` | |
| `GET /api/catalogue` | shapes, systems, patterns, fonts, limits — so a storefront need not hardcode them |
| `POST /api/plates` | a spec in, dimensions / stud count / file size / delivered price out. Add `zone` to price a destination; every zone comes back priced too. Keeps nothing |
| `POST /api/baskets` | a whole order in one box: several `{spec\|designId, quantity}` lines, one shared delivery |
| `POST /api/plates/stl` | the print file. Admin-only unless `ALLOW_PUBLIC_STL=1` |
| `POST /api/designs` | keep a design, get an id back |
| `GET /api/designs/:id` | what was ordered. Never the STL |
| `GET /api/designs/:id/preview.png` | |
| `POST /webhooks/shopify/orders-create` | HMAC-verified |
| `GET /admin` | the review console |
| `GET /api/admin/orders` | `?status=new\|approved\|printed\|rejected` |
| `POST /api/admin/orders/:id/status` | |
| `GET /api/admin/designs/:id/plate.stl` | the file that goes on the printer |

Everything under `/api/admin` needs `Authorization: Bearer $ADMIN_TOKEN`.
`POST /api/designs` is additionally limited to the origins in
`ALLOWED_ORIGINS`.

Out-of-range numbers in a spec are **clamped**, not refused: a slider dragged
past a limit and a hand-written value that is merely optimistic mean the same
thing. Only an unknown *name* — a shape or system this build cannot make — is an
error, because there is nothing sensible to clamp it to.

### Pricing

A quote is `PRICE_BASE + grams × PRICE_PER_GRAM + hours × PRICE_PER_HOUR`, and
the grams and the hours come from **slicing the plate**, not from its volume.

That distinction is the point. A print is a few perimeters, a solid skin top and
bottom, and mostly air in between, and how much air depends on the shape in a
way no formula predicts:

| | solid volume | actually printed |
|---|---|---|
| 20 × 20 baseplate, 1.3 mm | 59 g | 49 g — 85 % |
| 20 × 20 plate, 6 mm thick | 212 g | 78 g — 37 % |

Same footprint, and pricing the second by volume would overcharge by nearly
three times. Set `PRINT_PROFILE` and the overrides beside it to the way your
shop really prints; the quote is only as good as that matches.

### Shipping

Shipping is quoted from the **box**, not from the weight, because for these
products the box is what decides. A carrier bills whichever is greater — what a
parcel weighs, or what its size says it should weigh — and a printed plate is
light and the size of a sheet of paper:

| | in the box | actual | volumetric | billed |
|---|---|---|---|---|
| 6 × 6 tile | 7 × 7 × 3 cm | 0.13 kg | 0.05 kg | **0.13 kg**, by weight |
| 28 × 25 baseplate | 25 × 23 × 3 cm | 0.21 kg | 0.34 kg | **0.34 kg**, by size |
| 40 × 40 baseplate | 35 × 35 × 3 cm | 0.32 kg | 0.73 kg | **0.73 kg**, by size |

So the generator builds the parcel — the plate's footprint plus padding, and a
minimum depth, because a flat plate still needs a box with some depth to it —
works out both weights, and prices the greater against the destination's
brackets. Past the last bracket the per-kilo rate takes over, so an oversized
order is quoted rather than refused.

**The built-in zone prices are placeholders.** They have the shape a carrier's
price list takes, filled in with plausible numbers so the thing quotes something
sensible out of the box. Put your carrier's own in `SHIPPING_ZONES` before you
sell anything. `SHIPPING_FLAT` replaces the table with a single price if you
charge the same to send anything, `SHIPPING_FREE_ABOVE` waives it over a
threshold, and `SHIPPING_ENABLED=0` drops it from the quote entirely.

`POST /api/plates` quotes **one plate in one parcel**. A whole order goes to
`POST /api/baskets` instead, which is the same pricing over one shared box —
see below.

### A whole basket

Quoting a cart line by line and adding it up charges for deliveries that will
not happen: three plates go in one box. `POST /api/baskets` prices the order as
one parcel.

```jsonc
{
  "zone": "pt",
  "items": [
    { "spec": { "shape": "rect", "width": 28, "depth": 25 }, "quantity": 1 },
    { "designId": "9857e067159f45e3a939", "quantity": 2 }   // what a cart holds
  ]
}
```

The plates are packed the way someone packing them would: flat, largest first,
smaller ones laid beside a bigger one where there is room, a new layer when
there is not. The box's footprint is the largest plate in it and its depth is
the layers stacked up. A baseplate and three small tiles come out as one
two-layer box at €3.50 rather than four parcels at €14.00.

The area rule is deliberately conservative — two plates whose areas fit a layer
might still not fit side by side, so a fifth of each layer is held back. Over-
quoting a box by a layer costs a little; under-quoting one costs the difference
on every order that ships.

The **base fee is per plate, not per order**: each is its own print, with its own
bed to clear and part to check. Only the delivery is shared. And the arithmetic
is one a customer can redo by hand — unit price × quantity, lines adding to the
goods, goods plus delivery — so the rounding happens at the unit price rather
than after multiplying.

`BASKET_MAX_LINES`, `BASKET_MAX_QUANTITY` and `BASKET_MAX_UNITS` bound it.
Identical plates are built and sliced once however many were ordered, so what is
bounded tightly is the number of *different* plates, not the count.

### Deploying the two apart

The backend reads `../../assets/js/plate.js` and `../../assets/js/stl.js`
relative to `server/src/`. If you deploy `server/` on its own, take `assets/js/`
with it and keep the layout — those two files are the contract between the
preview and the print.

## Selling it

`storefront/` has the Shopify side:

- `configurator-bridge.js` — posts the design to the backend, then puts only the
  returned id on the cart line as `_design_id`. The design never travels through
  the cart: line item properties are small, customer-visible and awkward to
  validate.
- `demo.html` — a product page that embeds the configurator, quotes it live off
  the backend and saves a design. It is a demonstration, so the `/cart/add.js`
  step is simulated; the design really is stored and shows up in `/admin`.

The configurator itself takes two query flags:

- `?embed=1` — drop the page's own header, for a host page that has one.
- `?shop=1` — selling context: no STL download, because in a shop the file is
  the product.

A host page talks to it either directly through `window.LegoPlate.getDesign()`
or, across an iframe, by posting `{ type: 'plate:getDesign', requestId }` and
listening for `plate:design`. Every rebuild also broadcasts `plate:changed` with
the size, stud count and weight, so a page can keep a price beside the preview
without asking.

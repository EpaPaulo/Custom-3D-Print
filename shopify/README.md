# Order backend — personalised TM7 covers

Turns a design made in the configurator into a print file you hold, and an
order you can review before it reaches a printer.

The cover prints black and the design prints white, flush with the surface —
no relief. Two bodies, two filaments.

The customer never receives an STL. They design, they see a preview, they buy;
you get the model. That is the whole point of the split — hand over the STL and
you have sold the thing that lets anyone print it forever.

## The flow

```
browser                     backend                        you
───────                     ───────                        ───
design in configurator
  │
  │ POST /api/designs  { config, maskPng, previewPng }
  ├──────────────────────────▶ store design, return id
  │                                 │
  │ ◀───────────────────────────────┘  { id, previewUrl }
  │
  │ POST /cart/add.js  properties: { _design_id: id, Pré-visualização: url }
  ├──▶ Shopify cart ──▶ checkout ──▶ order
                                      │
                        POST /webhooks/shopify/orders-create (HMAC signed)
                                      ├──▶ file order as pending_review
                                      │
                                            GET /admin/queue ◀──── you review
                                            POST /admin/orders/:id/status
                                            GET  /admin/designs/:id/model.stl
                                                     │
                                                     └──▶ slicer ──▶ printer
```

## Why the browser sends a bitmap, not a font name

`POST /api/designs` takes the **rasterised stamp mask** — the black-and-white
image the configurator already builds to displace geometry.

Rendering the text server-side instead would mean installing the same fonts the
customer's browser happened to use. When they differ, the print quietly stops
matching the preview the customer approved, and you find out from a complaint.
A bitmap cannot drift.

It costs nothing in safety, because the geometry is still built here, by our own
code, from the fixed models. The customer supplies a bounded greyscale image;
they can never hand you triangles to put on a printer. Uploading a finished STL
would be the dangerous design, and this is not that.

The design body's surface sits exactly on the model's face and runs inward, so
it occupies the part rather than standing on it — which is what makes the two
filaments meet flush.

### Models

The backend builds every model in the `models` list in `src/config.js`, which
has to track `MODELS` in `assets/js/app.js` — the configurator stamps an id
onto each design, and that id picks the mesh, the face, and the usable area the
mask is measured against. An id this backend does not know is refused at
`POST /api/designs`, so a design can never be fulfilled on the wrong mesh.

Meshes are parsed once and kept, so a shop that only ever sells one never pays
for the other. `MODEL_DIR` says where the files live.

A model with a **round** face — the TM7 base — reports `round: true` and a
`usableDiameter` rather than a rectangle, and its design is cut to that disc as
the body is built. The configurator's preview applies the same cut, so what
gets printed is what the customer approved.

## Endpoints

### Storefront (CORS-limited to `ALLOWED_ORIGINS`)

| | |
|---|---|
| `GET /api/models` | every model on offer, with dimensions and usable area |
| `GET /api/template?model=<id>` | one model's dimensions; the first one if unasked |
| `POST /api/designs` | `{ config, maskPng, previewPng }` → `{ id, previewUrl }` |
| `GET /api/designs/:id` | design metadata — **no mask, no STL** |
| `GET /api/designs/:id/preview.png` | the preview, for the cart thumbnail |

### Admin (`Authorization: Bearer $ADMIN_TOKEN`)

| | |
|---|---|
| `GET /admin` | the review console (HTML, no token needed to load) |
| `GET /admin/queue?status=pending_review` | orders awaiting review |
| `POST /admin/orders/:id/status` | `{ status, note }` — approve / reject / printed |
| `GET /admin/cover.stl?model=<id>` | that model's black body — same every order, fetch once |
| `GET /admin/designs/:id/model.stl` | the white design body for this order |

`model.stl` refuses a design whose order has not been approved (`409`). Pass
`?force=1` to override for a design with no order behind it — a sample, or a
proof for a customer. Both STL routes name the model in an `X-Model-Id` header
and in the download filename, so a file that has left the console can still be
paired with the right black body. `/admin/queue` reports each order's `models`
for the same reason: nothing can be printed until the right body is on the bed.

Only the design varies per order, so the black body is not reissued each time.
In the slicer, load the two as *one object with two parts* — they share a
coordinate system, so they land aligned — and assign a filament to each. They
cannot be one file: STL carries no notion of parts or colour, so anything
merged would print in a single colour.

### Webhook

`POST /webhooks/shopify/orders-create` — HMAC-SHA256 verified against the raw
body before it is parsed. An unsigned or wrongly-signed request is refused, not
trusted. Register it in Shopify for the **Order creation** topic.

## The review console

`GET /admin` serves a single-page console for working the queue: filter by
status with live counts, see each order's preview and which model it needs,
approve or reject with a reason, pull the print file or a model's black body,
and mark it printed.

The page itself carries no data and no credential, so it loads without a
token — it asks for one, keeps it in `sessionStorage` (not `localStorage`: it
should not outlive the tab) and sends it on every request. Every data route
behind it still refuses an unauthenticated call, which the tests assert
directly so serving the page can never quietly open them up.

Status is encoded as form as well as text — a coloured stripe down each card
and a pill — so a queue can be read at a glance. Semantic colour is kept
separate from the accent, so "needs attention" never competes with "this is
the button".

## Running it

```sh
cp .env.example .env      # then fill in ADMIN_TOKEN and SHOPIFY_WEBHOOK_SECRET
npm install
npm start
```

It refuses to start without those two secrets rather than defaulting to
something insecure.

```sh
npm test                  # 14 checks, real HTTP against a temp data dir
```

## Storefront wiring

`storefront/demo.html` is a working product page — open it with both servers
running to see the whole flow. It stubs Shopify's `/cart/add.js`, which does
not exist off-platform, but the design really is sent to the backend. Its own
`?model=` picks which product it stands in for (`demo.html?model=base` for the
round base) and passes it to the iframe; a real theme hardcodes one per
product.

Embed the configurator with **`?shop=1`**. That mode drops its own header, the
parametric generator and, critically, every route to the STL — including the
export function itself, not just the buttons. Handing a shopper the model would
give away the product.

One page sells one model. `?shop=1` pins the configurator to the display cover;
`?shop=1&model=base` pins it to the round base instead, and the picker
disappears either way. One backend serves them all — each design says which
model it is, and the console tells the operator which black body an order
needs — so a second product is a second Shopify product and a second iframe
URL, not a second deployment.

Add the configurator and `storefront/configurator-bridge.js` to the product
page (theme app extension, or a `<script type="module">`), then:

```html
<button data-cover-add data-variant-id="{{ product.selected_variant.id }}">
  Adicionar ao carrinho
</button>
<p data-cover-error></p>

<iframe data-cover-frame src="https://your-configurator/index.html?shop=1"></iframe>

<script type="module">
  import { autoWire } from '{{ 'configurator-bridge.js' | asset_url }}';
  autoWire('https://orders.yourdomain.com');
</script>
```

The bridge asks the configurator for the design over `postMessage` when it is
in an iframe, or reads `window.BimbyCover.getDesign()` directly when both live
on the same page. Either way it refuses anything built in *medidas próprias* —
custom sizes are a design tool, not a product you print.

`_design_id` is underscore-prefixed, Shopify's convention for a property hidden
from the customer-facing cart. It still shows on the order in your admin, which
is where fulfilment reads it.

## Storage

Files on disk under `DATA_DIR`: `designs/<id>.json`, `<id>-mask.png`,
`<id>-preview.png`, and `orders/<orderId>.json`. Writes go through a temp file
and a rename, so a crash cannot leave a torn record.

A print shop's volume is bounded by printer hours, not database throughput, so
this is the right size of tool: no daemon, no migrations, and the entire state
is readable with `ls` and `cat`. Back up `DATA_DIR` — it is the only copy of
what customers bought. If you outgrow it, `store.js` is the only file that
needs to change.

## Things this deliberately does not do

- **Price by size.** Use Shopify variants; Cart Transform if you truly need
  continuous pricing.
- **Auto-approve.** Every personalised order waits for a human. Customers will
  submit logos they do not own and words you will not want to print, and this
  is the cheapest possible place to catch that.
- **Render 3D server-side.** The preview comes from the browser, which already
  has the scene. Headless GL on a server is a lot of machinery for a thumbnail.

## Splitting this into its own repo

`src/render.js` imports three files from the storefront repo:

```
../../assets/js/template.js
../../assets/js/geom.js
```

They have no DOM dependencies and run unchanged under Node. To split the repos,
copy those files in, point `MODEL_DIR` at a copy of `assets/model/`, and fix
the two import paths. Keep one source of truth for the geometry — if the
configurator's geometry and the backend's ever diverge, previews stop matching
prints. The model registries are the other thing to keep in step: `models` in
`src/config.js` and `MODELS` in the configurator's `app.js` share their ids.

## Before you sell anything

Personalised goods made to a customer's specification are exempt from the EU's
14-day right of withdrawal (Directive 2011/83/EU, Art. 16(c)) — which matters
when every item is unsellable to anyone else. State it clearly at checkout, and
confirm the wording with your own advisor.

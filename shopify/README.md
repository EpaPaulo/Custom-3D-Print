# Order backend — personalised TM7 covers

Turns a design made in the configurator into a print file you hold, and an
order you can review before it reaches a printer.

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
code, from the fixed template. The customer supplies a bounded greyscale image;
they can never hand you triangles to put on a printer. Uploading a finished STL
would be the dangerous design, and this is not that.

Verified: an STL rendered by this service from a real browser design is
byte-for-byte the template plus the same 9,116 design triangles the browser
itself produces.

## Endpoints

### Storefront (CORS-limited to `ALLOWED_ORIGINS`)

| | |
|---|---|
| `GET /api/template` | template dimensions and usable design area |
| `POST /api/designs` | `{ config, maskPng, previewPng }` → `{ id, previewUrl }` |
| `GET /api/designs/:id` | design metadata — **no mask, no STL** |
| `GET /api/designs/:id/preview.png` | the preview, for the cart thumbnail |

### Admin (`Authorization: Bearer $ADMIN_TOKEN`)

| | |
|---|---|
| `GET /admin` | the review console (HTML, no token needed to load) |
| `GET /admin/queue?status=pending_review` | orders awaiting review |
| `POST /admin/orders/:id/status` | `{ status, note }` — approve / reject / printed |
| `GET /admin/designs/:id/model.stl` | the print file |

`model.stl` refuses a design whose order has not been approved (`409`). Pass
`?force=1` to override for a design with no order behind it — a sample, or a
proof for a customer.

### Webhook

`POST /webhooks/shopify/orders-create` — HMAC-SHA256 verified against the raw
body before it is parsed. An unsigned or wrongly-signed request is refused, not
trusted. Register it in Shopify for the **Order creation** topic.

## The review console

`GET /admin` serves a single-page console for working the queue: filter by
status with live counts, see each order's preview, approve or reject with a
reason, pull the print file, and mark it printed.

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
not exist off-platform, but the design really is sent to the backend.

Embed the configurator with **`?shop=1`**. That mode drops its own header, the
base-model switch and, critically, every route to the STL — including the
export function itself, not just the buttons. Handing a shopper the model would
give away the product.

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
copy those files (plus `assets/model/tm7-cover.stl`) in and fix the two import
paths. Keep one source of truth for the geometry — if the configurator's
geometry and the backend's ever diverge, previews stop matching prints.

## Before you sell anything

Personalised goods made to a customer's specification are exempt from the EU's
14-day right of withdrawal (Directive 2011/83/EU, Art. 16(c)) — which matters
when every item is unsellable to anyone else. State it clearly at checkout, and
confirm the wording with your own advisor.

# The storefront

A shop front for the printing business, built to be walked rather than
deployed: seven niches, a catalogue, a product page, a cart and a checkout that
takes no money. It exists so the buying experience can be tried before any of
it is rebuilt as a Shopify theme.

Open `store/index.html` from any static server — there is no build step and no
backend required.

```sh
python3 -m http.server 8099      # from the repository root
```

Then <http://localhost:8099/store/>.

## The pages

| | |
|---|---|
| `index.html` | home — the seven niches, the personalisable row, best sellers |
| `collection.html?c=<niche>` | one category; also `?q=<termo>` for search and `?perso=1` for everything personalisable |
| `product.html?p=<handle>` | one product; personalisable ones open a generator |
| `cart.html` | cart, totals and the stub checkout |
| `lego-customizer.html` | the brick-plate generator (a prototype — see below) |

## What personalisation does

Most of the catalogue is picked and bought. Two categories are not: the Bimby
parts and the brick plates are designed by the customer first, so their **buy
button stays disabled until a design exists**. That is the point of the page,
not a detail of it — a personalised part is unsellable to anyone else, so an
order without a design is an order nobody can fill.

Pressing *Personalizar* opens the generator over the page:

- **Bimby** opens this repository's own configurator (`/index.html`) in
  `?shop=1` mode, which drops its header, the parametric generator and every
  route to the STL. Handing a shopper the model would give away the product.
- **LEGO** opens `lego-customizer.html`, a prototype: text on a stud grid, two
  filament colours, live measurements. It is a stand-in for the real brick
  generator, not the real thing.

Both speak the same three messages, which is what keeps the store from growing
a branch per category:

```
app  -> page   { type: 'bimby:ready' | 'bimby:change', hasDesign, mode, model }
page -> app    { type: 'bimby:getDesign', requestId }
app  -> page   { type: 'bimby:design', requestId, design }
```

`design` carries a config, the rasterised stamp mask and a preview PNG. The
store shrinks the preview to a thumbnail for the cart line, so the cart shows
what was actually designed rather than a stock picture of the part.

A third personalisable niche is an entry in `APPS` (in
`assets/customizer.js`) plus a `customizer` field on the catalogue rows — no
new code on the pages.

### Pointing at the real generators

- `?legoApp=<url>` on any store page sends the brick products to a different
  generator, when there is one to send them to.
- `?api=<origin>` points at the order backend in `shopify/`. With it set, a
  finished design is **filed** — `POST /api/designs` — and the cart line
  carries the returned id, which is what fulfilment reads. Without it (the
  usual way to try this) the design stays in the browser and only the thumbnail
  travels, which is honest: nothing was filed, so nothing can be printed.

```sh
# the whole thing, wired together
cd shopify && npm start                                   # order backend on :3111
open http://localhost:8099/store/index.html?api=http://localhost:3111
```

## What is real and what is not

Real: the catalogue, the navigation, search and sorting, variants, the
quantity rules, the cart maths, the personalisation flow and the previews it
produces. The cart lives in `localStorage`, so a refresh does not lose it.

Not real: payment. *Finalizar compra* empties the cart and shows a reference —
no Shopify order is created and nothing is charged. Prices, ratings, review
counts and delivery estimates are placeholders for judging the layout, not
quotes.

Product photography does not exist yet either, so every product image is drawn
as an SVG in `assets/ui.js` — build plate, layer lines, the niche's glyph,
seeded from the handle so a product always looks the same and following the
filament colour the shopper picked. Swapping in photographs later is one field
on the catalogue entry and one branch in `art()`.

## Layout

```
store/
  index.html            home
  collection.html       category / search / personalisable
  product.html          product detail + the personalisation step
  cart.html             cart + stub checkout
  lego-customizer.html  brick-plate generator (prototype)
  assets/
    catalog.js          niches, products, variants — the only source of products
    ui.js               money, product artwork, header/footer, cards, toast
    cart.js             the localStorage cart, and preview thumbnailing
    customizer.js       the generator modal and the design-app registry
    home.js  collection.js  product.js  cart-page.js
    store.css
```

`catalog.js` is where a real theme differs most: every field in it comes out of
Liquid on Shopify — collections, products, variants — and the pages only read
it through the helpers at the bottom of the file, so replacing it with a fetch
is the whole migration. `cart.js` is the other seam: five methods, all of which
Shopify's `/cart/*.js` answers.

## Against the existing demo page

`shopify/storefront/demo.html` remains what it was: a single product page that
stands in for a real theme, wired to the order backend through
`configurator-bridge.js`, and the thing to copy from when building the theme
for real. This storefront is the shop around it — the browsing, the categories
and the cart that page assumes already exist.

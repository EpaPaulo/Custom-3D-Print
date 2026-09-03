# FormCAT — the storefront

FormCAT's shop front, built to be walked rather than deployed: seven niches, a
catalogue, a product page, a cart and a checkout that takes no money. It exists
so the buying experience can be tried before any of it is rebuilt as a Shopify
theme.

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
- **LEGO** opens the plate generator (`/lego/index.html`) in `?shop=1` mode,
  where the shape, the size in studs and the stud calibration are the design.

They are two apps with two protocols — `bimby:*` and `plate:*` — and one
carries a rasterised mask while the other carries a plate spec. Rather than
teach the modal both, each entry in `APPS` (`assets/customizer.js`) declares
its own message names and a `read()` that turns that app's payload into the one
shape the cart stores: a summary, a preview and whatever the backend needs.
The pages above know only that a design arrived, so a third generator is an
entry in `APPS` plus a `customizer` field on the catalogue rows.

The preview is shrunk to a thumbnail for the cart line, so the cart shows what
was actually designed rather than a stock picture of the part.

### Pointing at an order backend

`?api=<origin>` files each finished design — `POST /api/designs` — and the cart
line carries the returned id, which is what fulfilment reads. Without it (the
usual way to try this) the design stays in the browser and only the thumbnail
travels, which is honest: nothing was filed, so nothing can be printed. The two
products have two backends (`shopify/` and `lego/server/`), so one `?api=` is
enough to try either, not both at once.

```sh
# with the Bimby order backend behind it
cd shopify && npm start                                   # :3111
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

`shopify/storefront/demo.html` and `lego/storefront/demo.html` remain what they
were: single product pages that stand in for a real theme, wired to their own
backends through their own bridges, and the things to copy from when building
the theme for real — the LEGO one also quotes a live price from the slice,
which this storefront does not.

This storefront is the shop around them: the browsing, the categories and the
cart those pages assume already exist. It prices from the catalogue instead of
from the backend, which is the right trade for judging a purchase flow and the
wrong one for taking money.

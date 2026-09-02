import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  buildPlate, normaliseSpec, resolve, SpecError,
  SHAPES, SYSTEMS, PATTERNS, QUALITIES, DEFAULTS, LIMITS, FONTS, CHARACTERS,
} from './plate.js';
import { buildOutline } from './shapes.js';
import { slicePrint, PROFILES, DEFAULT_PROFILE } from './slice.js';
import { priceOf, RATES, ZONES, DEFAULT_ZONE } from './price.js';
import { trianglesToSTL, downloadBlob } from './stl.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'lego-plate-v1';

// Embedding options, read from the query string.
//   ?embed=1   drop the page's own header — the host page has its own
//   ?shop=1    selling context: the preview and the price, but no STL
// Handing a shopper the STL would give away the product, so shop mode removes
// every route to it rather than merely hiding the buttons.
const params = new URLSearchParams(location.search);
const EMBED = params.has('embed') || params.has('shop');
const SHOP = params.has('shop');

// Common build volumes, so "will this fit on my printer" is a question the app
// can answer rather than one the customer has to work out from millimetres.
const BEDS = [
  { id: 'none', label: 'Sem limite', x: Infinity, y: Infinity },
  { id: '180', label: '180 × 180 mm', x: 180, y: 180 },
  { id: '220', label: '220 × 220 mm — Ender 3', x: 220, y: 220 },
  { id: '250', label: '250 × 210 mm — Prusa MK4', x: 250, y: 210 },
  { id: '256', label: '256 × 256 mm — Bambu P1/X1', x: 256, y: 256 },
  { id: '300', label: '300 × 300 mm', x: 300, y: 300 },
  { id: '350', label: '350 × 350 mm — grande formato', x: 350, y: 350 },
];

const COLOURS = [
  { id: 'red', label: 'Vermelho', hex: 0xc4281c },
  { id: 'yellow', label: 'Amarelo', hex: 0xf2cd37 },
  { id: 'blue', label: 'Azul', hex: 0x0055bf },
  { id: 'green', label: 'Verde', hex: 0x237841 },
  { id: 'grey', label: 'Cinzento', hex: 0x9ba19d },
  { id: 'white', label: 'Branco', hex: 0xf2f3f2 },
  { id: 'black', label: 'Preto', hex: 0x2b2b2b },
  { id: 'tan', label: 'Bege', hex: 0xe4cd9e },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let spec = { ...DEFAULTS };
let view = { colour: 'red', bed: 'none', wire: false, profile: DEFAULT_PROFILE, zone: DEFAULT_ZONE };
let rates = { ...RATES };
// Empty means "use the zone table"; a number replaces it. `freeAbove` of zero
// never waives the charge.
let shipping = { flat: null, freeAbove: 0 };
let current = null;   // the last successful build
let print = null;     // the last slice of it

restore();

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

// Every slider is declared once: which spec field it drives, and how its value
// reads back to the customer. Nothing else in the file needs to know they exist.
const SLIDERS = [
  { el: 'f-width', out: 'o-width', key: 'width', fmt: (v) => `${v} pinos · ${mm(dims().width)}` },
  { el: 'f-depth', out: 'o-depth', key: 'depth', fmt: (v) => `${v} pinos · ${mm(dims().depth)}` },
  { el: 'f-corner', out: 'o-corner', key: 'corner', fmt: (v) => mm(v) },
  { el: 'f-sides', out: 'o-sides', key: 'sides', fmt: (v) => `${v}` },
  { el: 'f-points', out: 'o-points', key: 'points', fmt: (v) => `${v}` },
  { el: 'f-inner', out: 'o-inner', key: 'innerRatio', fmt: (v) => `${Math.round(v * 100)} %` },
  { el: 'f-rotation', out: 'o-rotation', key: 'rotation', fmt: (v) => `${v}°` },
  { el: 'f-arm', out: 'o-arm', key: 'arm', fmt: (v) => `${v} pinos` },
  { el: 'f-armx', out: 'o-armx', key: 'armX', fmt: (v) => `${v} pinos` },
  { el: 'f-army', out: 'o-army', key: 'armY', fmt: (v) => `${v} pinos` },
  { el: 'f-scale', out: 'o-scale', key: 'scale', fmt: (v) => `${v > 1 ? '+' : ''}${((v - 1) * 100).toFixed(1)} %` },
  { el: 'f-thickness', out: 'o-thickness', key: 'thickness', fmt: (v) => mm(v) },
  { el: 'f-studheight', out: 'o-studheight', key: 'studHeight', fmt: (v) => mm(v) },
  { el: 'f-studdia', out: 'o-studdia', key: 'studDiameter', fmt: (v) => mm(v) },
  { el: 'f-pitch', out: 'o-pitch', key: 'pitch', fmt: (v) => mm(v) },
  { el: 'f-clearance', out: 'o-clearance', key: 'clearance', fmt: (v) => mm(v) },
];

const mm = (v) => `${(Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '')} mm`;
const dims = () => resolve(safeSpec());

// The controls can be left in a state the builder refuses — too many studs, a
// stud wider than its own cell — and the numbers still have to be readable
// while that is true. This answers with the nearest thing that does resolve.
function safeSpec() {
  try {
    return normaliseSpec(spec);
  } catch {
    const shape = SHAPES.some((s) => s.id === spec.shape) ? spec.shape : DEFAULTS.shape;
    return normaliseSpec({ ...DEFAULTS, shape });
  }
}

// The glyph on each button is the shape's own outline, at the proportions it
// is drawn in. Nothing here describes what a pumpkin looks like — so the button
// cannot end up showing something the generator does not build.
function shapeIcon(shape) {
  // The letter button shows the letter currently chosen, so the picker says
  // what it will give you rather than showing a stand-in A forever.
  const spec = normaliseSpec(shape.id === 'text'
    ? { shape: 'text', depth: shape.size[1], char: state().char, font: state().font }
    : { shape: shape.id, width: shape.size[0], depth: shape.size[1] });
  const d = resolve(spec);
  // Coarse on purpose: the glyph is 24 px across, and no detail finer than that
  // survives being drawn at that size.
  const rings = buildOutline(spec, d.width, d.depth, Math.max(d.width, d.depth) / 30);
  const all = [rings.outer, ...rings.holes];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of all) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Fit the longer side into 22 of the 24 px, keeping the aspect — a candy cane
  // squashed into a square would be exactly the confusion the icon is for.
  const k = 22 / Math.max(maxX - minX, maxY - minY, 1e-6);
  const ox = 12 - ((minX + maxX) / 2) * k;
  const oy = 12 + ((minY + maxY) / 2) * k;

  const path = all
    .map((ring) => ring
      .map(([x, y], i) => `${i ? 'L' : 'M'}${(x * k + ox).toFixed(1)} ${(oy - y * k).toFixed(1)}`)
      .join('') + 'Z')
    .join('');

  // evenodd so a letter's counters read as holes rather than filling in.
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${path}"/></svg>`;
}

// The bits of state the icons need before `spec` is necessarily valid.
const state = () => ({ char: spec.char || DEFAULTS.char, font: spec.font || DEFAULTS.font });

// Redraw just the letter button, after the character or the face changes.
function refreshTextIcon() {
  const button = $('shapes').querySelector('button[data-shape="text"]');
  const shape = SHAPES.find((s) => s.id === 'text');
  if (!button || !shape) return;
  try {
    button.innerHTML = `${shapeIcon(shape)}<span>${shape.label}</span>`;
  } catch {
    // An unbuildable character is reported by the panel; the icon just waits.
  }
}

function buildShapePicker() {
  const host = $('shapes');
  host.innerHTML = '';
  for (const s of SHAPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.shape = s.id;
    b.title = s.label;
    b.innerHTML = `${shapeIcon(s)}<span>${s.label}</span>`;
    b.addEventListener('click', () => {
      spec.shape = s.id;
      // Start at the proportions the shape was drawn in. Both sliders still do
      // what they say; this only decides where they start. A letter's width is
      // not a slider at all, so only its height is set here.
      if (s.size) {
        spec.depth = s.size[1];
        if (!s.derivedWidth) spec.width = s.size[0];
      }
      writeControls();
      changed();
    });
    host.appendChild(b);
  }
}

function buildSelects() {
  fill($('f-system'), SYSTEMS.map((s) => [s.id, s.label]));
  fill($('f-pattern'), PATTERNS.map((p) => [p.id, p.label]));
  fill($('f-quality'), Object.entries(QUALITIES).map(([id, q]) => [id, q.label]));
  fill($('f-bed'), BEDS.map((b) => [b.id, b.label]));
  fill($('f-font'), FONTS.map((f) => [f.id, f.label]));
  fill($('f-profile'), Object.entries(PROFILES).map(([id, p]) => [id, p.label]));
  fill($('f-zone'), ZONES.map((z) => [z.id, z.label]));

  const host = $('swatches');
  for (const c of COLOURS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.colour = c.id;
    b.title = c.label;
    b.style.background = `#${c.hex.toString(16).padStart(6, '0')}`;
    b.addEventListener('click', () => {
      view.colour = c.id;
      paint();
      save();
    });
    host.appendChild(b);
  }
}

function fill(select, pairs) {
  select.innerHTML = '';
  for (const [value, label] of pairs) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }
}

// Only the parameters the chosen shape actually reads are on show; the rest
// keep their values silently, so switching shape and back loses nothing.
function syncShapeFields() {
  const wanted = new Set((SHAPES.find((s) => s.id === spec.shape) || SHAPES[0]).params);
  const map = {
    char: 'f-char-field',
    font: 'f-font-field',
    corner: 'f-corner-field',
    sides: 'f-sides-field',
    rotation: 'f-rotation-field',
    points: 'f-points-field',
    innerRatio: 'f-inner-field',
    arm: 'f-arm-field',
    armX: 'f-armx-field',
    armY: 'f-army-field',
  };
  for (const [key, id] of Object.entries(map)) $(id).hidden = !wanted.has(key);
  $('char-note').hidden = !wanted.has('char');

  // A letter's width follows from the glyph, so there is no slider for it —
  // and what the other shapes call depth is, for a letter, its height.
  const shape = SHAPES.find((s) => s.id === spec.shape);
  const derived = Boolean(shape && shape.derivedWidth);
  $('width-field').hidden = derived;
  $('depth-label').firstChild.nodeValue = derived ? 'Altura da letra ' : 'Profundidade ';

  for (const b of $('shapes').children) b.classList.toggle('on', b.dataset.shape === spec.shape);
}

function writeControls() {
  for (const s of SLIDERS) {
    const el = $(s.el);
    el.value = spec[s.key];
    $(s.out).textContent = s.fmt(Number(el.value));
  }
  $('f-system').value = spec.system;
  $('f-pattern').value = spec.pattern;
  $('f-quality').value = spec.quality;
  $('f-hollow').checked = spec.hollowStuds;
  $('f-bed').value = view.bed;
  $('f-char').value = spec.char;
  $('f-font').value = spec.font;
  $('f-profile').value = view.profile;
  $('f-zone').value = view.zone;
  $('f-rate-base').value = rates.base;
  $('f-rate-gram').value = rates.perGram;
  $('f-rate-hour').value = rates.perHour;
  $('f-ship-flat').value = shipping.flat == null ? '' : shipping.flat;
  $('f-ship-free').value = shipping.freeAbove || '';

  syncRanges();

  for (const b of $('swatches').children) b.classList.toggle('on', b.dataset.colour === view.colour);
  $('btn-wire').classList.toggle('on', view.wire);
  syncShapeFields();
}

// Two of the shape parameters are measured against the plate rather than in
// the abstract — a corner radius is a length, an arm is a count of studs — so
// their ceilings move when the plate does.
function syncRanges() {
  const d = dims();
  $('f-corner').max = Math.max(1, Math.round(Math.min(d.width, d.depth) / 2));
  const cap = Math.max(spec.width, spec.depth);
  for (const id of ['f-arm', 'f-armx', 'f-army']) $(id).max = cap;
}

function wireControls() {
  for (const s of SLIDERS) {
    $(s.el).addEventListener('input', () => {
      spec[s.key] = Number($(s.el).value);
      $(s.out).textContent = s.fmt(spec[s.key]);
      changed();
    });
  }

  $('f-system').addEventListener('change', () => {
    // Switching system resets the stud figures to that system's own, since the
    // previous ones described a different brick entirely.
    const sys = SYSTEMS.find((s) => s.id === $('f-system').value);
    Object.assign(spec, {
      system: sys.id,
      pitch: sys.pitch,
      clearance: sys.clearance,
      studDiameter: sys.studDiameter,
      studHeight: sys.studHeight,
      thickness: sys.thickness,
      studWall: sys.studWall,
    });
    writeControls();
    changed();
  });

  for (const [id, key] of [['f-pattern', 'pattern'], ['f-quality', 'quality']]) {
    $(id).addEventListener('change', () => { spec[key] = $(id).value; changed(); });
  }

  $('f-hollow').addEventListener('change', () => { spec.hollowStuds = $('f-hollow').checked; changed(); });

  // One character, upper case. Typing a second replaces the first rather than
  // being ignored, which is what someone correcting a typo means by it.
  $('f-char').addEventListener('input', () => {
    const el = $('f-char');
    // Last character first, then upper-cased: "ß" upper-cases into two, and
    // doing it the other way round would silently leave an S in the box.
    const typed = el.value.slice(-1).toUpperCase();
    el.value = typed;
    if (!typed) return;                       // mid-edit; wait for a character
    if (typed.length !== 1 || !CHARACTERS.includes(typed)) {
      warn(`"${typed}" não existe como placa. Use A–Z ou 0–9.`);
      return;
    }
    spec.char = typed;
    refreshTextIcon();
    changed();
  });

  // Leaving the box empty is not a plate; put back whatever was last built.
  $('f-char').addEventListener('blur', () => { $('f-char').value = spec.char; });

  $('f-font').addEventListener('change', () => {
    spec.font = $('f-font').value;
    refreshTextIcon();
    changed();
  });
  $('f-bed').addEventListener('change', () => { view.bed = $('f-bed').value; stats(); save(); });

  $('f-profile').addEventListener('change', () => {
    view.profile = $('f-profile').value;
    save();
    requote();
  });

  // Where it ships to changes no geometry, so none of these re-slice.
  $('f-zone').addEventListener('change', () => { view.zone = $('f-zone').value; save(); showQuote(); });

  for (const [id, key] of [['f-rate-base', 'base'], ['f-rate-gram', 'perGram'], ['f-rate-hour', 'perHour']]) {
    $(id).addEventListener('input', () => {
      const value = Number($(id).value);
      rates[key] = Number.isFinite(value) && value >= 0 ? value : RATES[key];
      save();
      showQuote();
    });
  }

  $('f-ship-flat').addEventListener('input', () => {
    const raw = $('f-ship-flat').value.trim();
    const value = Number(raw);
    shipping.flat = raw !== '' && Number.isFinite(value) && value >= 0 ? value : null;
    save();
    showQuote();
  });

  $('f-ship-free').addEventListener('input', () => {
    const value = Number($('f-ship-free').value);
    shipping.freeAbove = Number.isFinite(value) && value > 0 ? value : 0;
    save();
    showQuote();
  });

  $('btn-reset').addEventListener('click', () => {
    spec = { ...DEFAULTS };
    writeControls();
    changed();
  });

  for (const id of ['btn-stl', 'btn-stl-2']) $(id).addEventListener('click', download);
  $('btn-snapshot').addEventListener('click', snapshot);

  $('btn-wire').addEventListener('click', () => { view.wire = !view.wire; paint(); save(); });
  $('btn-view-top').addEventListener('click', () => setView('top'));
  $('btn-view-iso').addEventListener('click', () => setView('iso'));
  $('btn-view-front').addEventListener('click', () => setView('front'));
}

// ---------------------------------------------------------------------------
// Rebuilding
// ---------------------------------------------------------------------------

let pending = 0;

// Dragging a slider asks for a new mesh on every pixel of travel. Coalescing
// those into one build per idle moment keeps the preview responsive without
// showing a stale plate: the badge says when it is behind.
function changed() {
  save();
  $('busy').hidden = false;
  clearTimeout(pending);
  pending = setTimeout(rebuild, 90);
}

function rebuild() {
  let built;
  try {
    built = buildPlate(spec);
  } catch (err) {
    if (!(err instanceof SpecError)) throw err;
    $('busy').hidden = true;
    warn(refusal());
    return;
  }
  current = built;
  $('busy').hidden = true;
  paint();
  stats();
  requote();
  announce();
}

// Why the current settings will not build. The two the sliders can actually
// reach are worth naming precisely; anything else gets the general answer.
function refusal() {
  const total = spec.width * spec.depth;
  if (total > LIMITS.maxStuds) {
    return `Demasiados pinos: ${spec.width} × ${spec.depth} são ${total} posições, ` +
           `e o limite é ${LIMITS.maxStuds}. Reduza uma das dimensões.`;
  }
  if (spec.shape === 'text' && !CHARACTERS.includes(spec.char)) {
    return `"${spec.char}" não existe como placa. Use uma letra A–Z ou um algarismo 0–9.`;
  }
  if (spec.studDiameter >= spec.pitch - 0.2) {
    return 'O pino é largo de mais para o passo da grelha. ' +
           'Reduza o diâmetro do pino ou aumente o passo, em Medidas avançadas.';
  }
  return 'Estas medidas não formam uma placa.';
}

function warn(message) {
  const el = $('warn');
  el.hidden = !message;
  el.textContent = message || '';
}

// Slicing costs more than rebuilding the mesh does, and nobody needs a price
// on every pixel a slider travels — so it trails the preview on its own timer
// and says so while it is behind.
let quotePending = 0;

function requote() {
  if (!current) return;
  print = null;
  $('q-busy').hidden = false;
  clearTimeout(quotePending);
  quotePending = setTimeout(() => {
    if (!current) return;
    print = slicePrint(current.positions, { profile: view.profile });
    $('q-busy').hidden = true;
    showQuote();
    // The host page's price waits on the slice, not on the mesh.
    announce();
  }, 260);
}

function showQuote() {
  if (!print) {
    for (const id of ['q-filament', 'q-time', 'q-layers', 'q-goods', 'q-ship', 'q-total']) {
      $(id).textContent = '—';
    }
    $('q-parcel').textContent = '';
    return;
  }

  // Re-price without re-slicing. The rates, the destination and the packaging
  // are all arithmetic on top of the slice, and the slice is the expensive bit.
  const quote = priceOf(print, {
    rates,
    shipping: {
      zone: view.zone,
      freeAbove: shipping.freeAbove,
      ...(shipping.flat != null ? { flat: shipping.flat } : {}),
    },
  });

  const hours = Math.floor(quote.hours);
  const minutes = Math.round((quote.hours - hours) * 60);

  $('q-filament').textContent = `${quote.grams.toFixed(0)} g · ${quote.metres.toFixed(1)} m`;
  $('q-time').textContent = hours ? `${hours} h ${minutes} min` : `${minutes} min`;
  $('q-layers').textContent = `${quote.layers} · ${quote.fill}% maciço`;
  $('q-goods').textContent = `${quote.goods.toFixed(2)} ${quote.currency}`;

  const ship = quote.shipping;
  $('q-ship-label').textContent = shipping.flat != null ? 'Envio (fixo)' : 'Envio';
  $('q-ship').textContent = ship.free
    ? 'grátis'
    : `${ship.price.toFixed(2)} ${quote.currency}`;
  $('q-total').innerHTML = `<strong>${quote.total.toFixed(2)} ${quote.currency}</strong>`;

  const p = ship.parcel;
  $('q-parcel').textContent = view.zone === 'pickup'
    ? 'Levantamento — sem custo de envio.'
    : `Caixa ${(p.lengthMm / 10).toFixed(0)} × ${(p.widthMm / 10).toFixed(0)} × ` +
      `${(p.heightMm / 10).toFixed(0)} cm · ${p.billedKg.toFixed(2)} kg facturados ` +
      `${p.billedBy === 'size' ? 'pelo volume — a placa é leve mas grande' : 'pelo peso'}.`;
}

function stats() {
  if (!current) return;
  const { size, triangles, studs } = current;

  $('s-dims').textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(2)} mm`;
  $('s-studs').textContent = `${studs.length}`;
  $('s-tris').textContent = triangles.toLocaleString('pt-PT');
  $('s-size').textContent = `${((84 + triangles * 50) / 1048576).toFixed(1)} MB`;

  const bed = BEDS.find((b) => b.id === view.bed);
  const overX = size.x > bed.x;
  const overY = size.y > bed.y;
  // A plate is square-ish, so it is worth saying that turning it 45° on the bed
  // buys nothing: what does not fit has to be printed in pieces.
  if (overX || overY) {
    warn(`Não cabe em ${bed.label}: ${size.x.toFixed(0)} × ${size.y.toFixed(0)} mm. ` +
         'Reduza a placa ou imprima-a em secções que depois encaixam.');
  } else if (studs.length === 0 && spec.pattern !== 'none') {
    warn('Nenhum pino cabe dentro desta forma. Aumente as dimensões.');
  } else {
    warn('');
  }

  syncRanges();

  const d = dims();
  const shape = SHAPES.find((s) => s.id === spec.shape);
  const built = current.spec;               // the width a letter worked out to
  $('fit-note').textContent = shape && shape.derivedWidth
    ? `"${built.char}" fica com ${built.width} pinos de largura — ` +
      `${size.x.toFixed(1)} × ${size.y.toFixed(1)} mm ao passo de ${mm(d.pitch)}.`
    : `Grelha de ${spec.width} × ${spec.depth} ao passo de ${mm(d.pitch)} — ` +
      `${size.x.toFixed(1)} × ${size.y.toFixed(1)} mm.`;
}

// ---------------------------------------------------------------------------
// 3D preview
// ---------------------------------------------------------------------------

const canvas = $('canvas');
// Transparent, so the panel's own backdrop shows through behind the plate and
// a saved snapshot comes out on transparency rather than on a colour someone
// then has to cut out.
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
// The plate is modelled lying in the XY plane with the studs up Z, which is how
// a slicer will see it, so the camera is told that Z is up rather than the mesh
// being rotated to suit the default.
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x33383f, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.4, -0.9, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.45);
rim.position.set(-0.8, 0.6, 0.5);
scene.add(rim);

const material = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.02 });
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x0f1216, wireframe: true, transparent: true, opacity: 0.35 });
let mesh = null;
let wire = null;
let framed = 0;   // the bounding radius the camera was last framed for

function paint() {
  if (!current) return;

  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  if (wire) {
    scene.remove(wire);
    wire = null;
  }

  const geometry = new THREE.BufferGeometry();
  // The build hands back a view into its own growable buffer; three.js keeps
  // the reference, so give it a copy that cannot be reused under it.
  geometry.setAttribute('position', new THREE.BufferAttribute(current.positions.slice(), 3));
  geometry.computeVertexNormals();

  material.color.setHex((COLOURS.find((c) => c.id === view.colour) || COLOURS[0]).hex);
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  if (view.wire) {
    wire = new THREE.Mesh(geometry, wireMaterial);
    scene.add(wire);
  }

  $('btn-wire').classList.toggle('on', view.wire);

  // Changing shape or size changes how much room the plate needs. Rather than
  // snapping back to a fixed view — which would throw away however the customer
  // had turned it — the camera keeps its direction and only moves in or out,
  // and only when the change is big enough to be worth it.
  const r = radius();
  if (!framed) setView('iso');
  else if (Math.abs(r - framed) / framed > 0.12) refit(r);
  framed = r;
}

// Distance at which the whole plate is in shot, from the field of view rather
// than a guess, so a 1-stud tile and a bed-sized plate both fill the frame.
function radius() {
  const s = current ? current.size : { x: 100, y: 100, z: 10 };
  return Math.hypot(s.x, s.y, s.z) / 2;
}

// Distance from the target at which a plate of this radius fills the frame.
function fitDistance(r) {
  return (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.12;
}

// Same distance, same direction, new size.
function refit(r) {
  const z = current ? current.size.z / 2 : 0;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.set(0, 0, z);
  camera.position.copy(dir.multiplyScalar(fitDistance(r)).add(controls.target));
  camera.near = Math.max(0.5, fitDistance(r) / 400);
  camera.far = fitDistance(r) * 12;
  camera.updateProjectionMatrix();
  controls.update();
}

function setView(which) {
  const d = fitDistance(radius());
  const z = current ? current.size.z / 2 : 0;

  controls.target.set(0, 0, z);
  if (which === 'top') camera.position.set(0, 0.001, z + d);
  else if (which === 'front') camera.position.set(0, -d, z + d * 0.12);
  else camera.position.set(d * 0.52, -d * 0.62, z + d * 0.58);

  camera.near = Math.max(0.5, d / 400);
  camera.far = d * 12;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  const box = $('viewport').getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe($('viewport'));

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function filename(ext) {
  const s = safeSpec();
  const what = s.shape === 'text' ? `letra-${s.char}-${s.font}` : s.shape;
  return `placa-${what}-${s.width}x${s.depth}.${ext}`;
}

function download() {
  if (SHOP || !current) return;
  const { buffer } = trianglesToSTL(current.positions, `lego-compatible plate ${spec.width}x${spec.depth}`);
  downloadBlob(new Blob([buffer], { type: 'model/stl' }), filename('stl'));
}

function snapshot() {
  renderer.render(scene, camera);
  canvas.toBlob((blob) => blob && downloadBlob(blob, filename('png')), 'image/png');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ spec, view, rates, shipping }));
  } catch {
    // A full or disabled store is not worth interrupting anyone over.
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    // Run it through the same validation an untrusted request gets: a stored
    // spec is from an older build as often as not.
    spec = normaliseSpec(saved.spec || {});
    if (saved.view) view = { ...view, ...saved.view };
    if (!PROFILES[view.profile]) view.profile = DEFAULT_PROFILE;
    if (saved.rates) rates = { ...rates, ...saved.rates };
    if (saved.shipping) shipping = { ...shipping, ...saved.shipping };
    if (!ZONES.some((z) => z.id === view.zone)) view.zone = DEFAULT_ZONE;
  } catch {
    spec = { ...DEFAULTS };
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (EMBED) document.body.classList.add('embed');

// The hint names the gesture that actually works here. A phone has no wheel,
// and telling someone to use one is worse than saying nothing.
if (matchMedia('(pointer: coarse)').matches) {
  $('hint').textContent = 'Arraste para rodar · dois dedos para ampliar';
}
if (SHOP) for (const id of ['btn-stl', 'btn-stl-2']) $(id).hidden = true;

buildShapePicker();
buildSelects();
writeControls();
wireControls();
resize();
rebuild();

// ---------------------------------------------------------------------------
// Host page API
// ---------------------------------------------------------------------------

// What a storefront needs to turn the plate on screen into an order: the spec,
// which is the whole design, and a picture of it for the basket. The mesh is
// deliberately not offered — the backend builds that from the spec, and handing
// it over here would be handing over the product.
window.LegoPlate = {
  get ready() {
    return Boolean(current);
  },

  getDesign() {
    if (!current) return null;
    renderer.render(scene, camera);
    return {
      spec: safeSpec(),
      size: current.size,
      studs: current.studs.length,
      profile: view.profile,
      zone: view.zone,
      previewPng: canvas.toDataURL('image/png'),
    };
  },

  // Driving the page from the outside: used by the tests, and by a host page
  // that wants to preset a size.
  get spec() { return { ...spec }; },
  set(patch) { Object.assign(spec, patch); writeControls(); rebuild(); },
  get result() { return current; },
  LIMITS,
};

// A shop embeds this page in an iframe, so the same API is reachable by
// postMessage. Replies go back only to the window and origin that asked.
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'plate:getDesign' || !event.source) return;
  let design = null;
  try {
    design = window.LegoPlate.getDesign();
  } catch (err) {
    console.error(err);
  }
  const target = event.origin && event.origin !== 'null' ? event.origin : '*';
  event.source.postMessage({ type: 'plate:design', requestId: msg.requestId, design }, target);
});

// Nothing identifying, just "there is something to buy" and what it costs to
// print — safe to broadcast so the host page can enable its button and show a
// live price.
function announce() {
  if (window.parent === window || !current) return;
  window.parent.postMessage({
    type: 'plate:changed',
    ready: true,
    shape: spec.shape,
    width: spec.width,
    depth: spec.depth,
    size: current.size,
    studs: current.studs.length,
    // The weight comes from the slice, so a host page showing it beside the
    // preview shows the same number the backend would quote.
    grams: print ? Math.round(print.grams) : null,
    hours: print ? print.hours : null,
  }, '*');
}

// Kept as the last thing every build does, so a host page hears about a plate
// only once it exists.
window.plateApp = window.LegoPlate;

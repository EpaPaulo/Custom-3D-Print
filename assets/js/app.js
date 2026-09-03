import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCover } from './geom.js';
import {
  renderMask, makeTextLayer, makeImageLayer, autoThreshold, inspectMask, FONTS,
} from './stamp.js';
import { trianglesToSTL, downloadBlob } from './stl.js';
import { parseSTL, analyseFace, buildInlaySolid, buildExportSTL } from './template.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'bimby-cover-v1';

// The supplied models. Each is a fixed mesh whose dimensions are the point of
// it, so the app never alters one — it only works out which flat face to
// personalise and lays the design onto it. `slug` names the exported files.
//
// Adding another model is one entry here plus the file under assets/model/.
const MODELS = [
  {
    id: 'cover',
    label: 'Capa do ecrã TM7',
    url: 'assets/model/tm7-cover.stl',
    slug: 'capa-tm7',
  },
  {
    id: 'base',
    label: 'Base TM7 — disco',
    url: 'assets/model/tm7-base.stl',
    slug: 'base-tm7',
  },
];

const CUSTOM = 'custom';
const modelSpec = (id) => MODELS.find((m) => m.id === id);

// Embedding options, read from the query string.
//   ?embed=1     drop the page's own header — the host page has its own
//   ?shop=1      selling context: no STL download, one model, no custom sizes
//   ?model=<id>  which supplied model to open with
// Handing a shopper the STL would give away the product, so shop mode removes
// every route to it rather than merely hiding the buttons.
const params = new URLSearchParams(location.search);
const EMBED = params.has('embed') || params.has('shop');
const SHOP = params.has('shop');
const WANTED_MODEL = modelSpec(params.get('model')) ? params.get('model') : null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'template',
  model: MODELS[0].id,
  style: 'shell',
  width: 230,
  height: 150,
  radius: 10,
  wall: 2,
  depth: 12,
  colourDepth: 0.6,
  cell: 0.5,
};

let state = { ...DEFAULTS };
let layers = [];
let selectedId = null;

// The model in use: its triangles, the flat face we stamp on, and the registry
// entry it came from. Meshes are fetched once and kept, so switching back to
// one already seen is instant.
let template = null;   // { positions, triangles, source }
let face = null;       // analyseFace() result
let model = null;      // the MODELS entry
const modelCache = new Map();

const isTemplate = () => state.mode === 'template' && template;

// Exports carry the model's own name; the parametric cover keeps the old one.
const slug = () => (isTemplate() ? model.slug : 'capa-tm7');

// Millimetres of design area available, whichever mode is active.
function designArea() {
  return isTemplate()
    ? { w: face.safeWidth, h: face.safeHeight }
    : { w: state.width, h: state.height };
}

// The design is a second filament occupying the first few layers of the cover,
// so it can never be thicker than the cover itself.
function maxColourDepth() {
  return isTemplate() ? 4 : Math.max(0.2, state.wall - 0.4);
}

// Where the design sits, in the frame the user sees it in. The template's face
// looks along -Z, so its layer +x maps to world -x; the parametric cover's
// face looks along +Z and needs no mirror.
function surfaceOf(topZ) {
  return isTemplate()
    ? { z: face.z, cx: face.cx, cy: face.cy, dir: -1, mirror: true, clip: face.clip }
    : { z: topZ, cx: 0, cy: 0, dir: 1, mirror: false, clip: 0 };
}

// Layers are positioned in millimetres from the centre of the design area, and
// the areas differ a lot between models, so a switch can leave one stranded
// off the face. Pulling them back in is kinder than letting them vanish.
function clampLayers() {
  const { w, h } = designArea();
  for (const l of layers) {
    l.x = Math.min(w / 2, Math.max(-w / 2, l.x || 0));
    l.y = Math.min(h / 2, Math.max(-h / 2, l.y || 0));
  }
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------

const canvas = $('canvas');
const viewport = $('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
// The part is black now, so the stage has to be lighter than it or the cover
// loses its silhouette entirely against the background.
scene.background = new THREE.Color(0x474d57);

// A tight near plane relative to far costs depth precision, which shows up as
// z-fighting where the design meets the cover face. The part is ~250 mm and is
// viewed from ~450 mm, so these bounds are generous and much better behaved.
const camera = new THREE.PerspectiveCamera(38, 1, 20, 3000);
camera.position.set(0, 0, 420);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 60;
controls.maxDistance = 1500;

scene.add(new THREE.HemisphereLight(0xeef3fa, 0x39404a, 1.25));

const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.4, 0.8, 1);
scene.add(key);

const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
fill.position.set(-0.8, -0.3, 0.6);
scene.add(fill);

// Grazing light along the edges, which is what separates a black part from a
// grey ground.
const rim = new THREE.DirectionalLight(0xffffff, 1.1);
rim.position.set(-0.3, 0.5, -1);
scene.add(rim);

const material = new THREE.MeshStandardMaterial({
  color: 0x24262a, roughness: 0.72, metalness: 0.02,
});

// The print is two filaments: a black cover and a white design.
const baseMaterial = new THREE.MeshStandardMaterial({
  color: 0x24262a, roughness: 0.72, metalness: 0.02,
});

const inlayMaterial = new THREE.MeshStandardMaterial({
  color: 0xf3f3ef, roughness: 0.62, metalness: 0.02,
});

// modelRoot orients the whole cover; holder recentres it so orbiting spins
// about the middle of the part rather than the STL's own origin.
const modelRoot = new THREE.Group();
scene.add(modelRoot);
const holder = new THREE.Group();
modelRoot.add(holder);

let mesh = null;        // the cover body (parametric only; template uses baseMesh)
let baseMesh = null;    // the untouched template body
let inlayMesh = null;   // the white design body
let lastBuild = null;   // { cover, inlay } triangle arrays for export

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(viewport);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Geometry rebuild
// ---------------------------------------------------------------------------

let maskCache = { key: null, mask: null };

function maskFor() {
  // Keyed on everything the mask depends on, but never on dataUrl — comparing
  // megabytes of base64 on every slider tick would cost more than redrawing.
  const area = designArea();
  const serial = JSON.stringify({
    w: area.w, h: area.h, c: state.cell,
    l: layers.map(({ src, _cache, dataUrl, ...rest }) => rest),
  });
  if (maskCache.key === serial) return maskCache.mask;
  const mask = renderMask(layers, area.w, area.h, state.cell);
  maskCache = { key: serial, mask };
  return mask;
}

// Two nozzle widths at 0.4 mm. Below this a colour change stops being a clean
// edge, and the preview cannot show that — the geometry is exact, the print is
// not.
const MIN_FEATURE_MM = 0.8;

// Measuring the mask costs a couple of passes, so it is cached alongside it
// rather than recomputed on every slider tick.
let detailCache = { mask: null, report: null };

function detailReport(mask) {
  if (!mask) return null;
  if (detailCache.mask === mask) return detailCache.report;
  const report = inspectMask(mask, MIN_FEATURE_MM);
  detailCache = { mask, report };
  return report;
}

function showDetailWarning(mask) {
  const el = $('detail-warn');
  if (!el) return;
  const r = detailReport(mask);
  if (!r) { el.hidden = true; return; }

  const tooSmall = r.minFeatureMm < MIN_FEATURE_MM;
  // Corner crumbs are filtered out upstream, so a healthy design measures a
  // flat zero here and anything at all is a real stroke.
  const tooThin = r.thinFraction > 0.005;
  if (!tooSmall && !tooThin) { el.hidden = true; return; }

  const parts = [];
  if (tooSmall) {
    parts.push(`o elemento mais pequeno mede ${mm(r.minFeatureMm)} mm`);
  }
  if (tooThin) {
    parts.push(`${Math.round(r.thinFraction * 100)}% do desenho tem traços finos`);
  }
  el.hidden = false;
  el.textContent =
    `Detalhe no limite: ${parts.join(' e ')}. Abaixo de ${mm(MIN_FEATURE_MM)} mm ` +
    '(dois filetes de um bico de 0,4) a mudança de cor pode não sair limpa. ' +
    'Aumente o tamanho da camada ou simplifique o desenho.';
}

// Shop mode strips the results panel, so writing a stat is best-effort.
function setStat(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function clearMesh() {
  for (const m of [mesh, inlayMesh]) {
    if (!m) continue;
    m.geometry.dispose();
    holder.remove(m);
  }
  mesh = null;
  inlayMesh = null;
}

// The inlay's surface is exactly coplanar with the cover's face, which is
// correct for printing and unresolvable for a depth buffer. Nudging the
// preview mesh a hair outward keeps the two apart on screen without touching
// the geometry that gets exported.
function showInlay(positions, dir) {
  if (!positions.length) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  inlayMesh = new THREE.Mesh(geom, inlayMaterial);
  inlayMesh.position.z = dir * 0.05;
  holder.add(inlayMesh);
}

// Template mode: the STL body is shown as-is and the design is a separate
// solid laid on its outward face. Nothing about the template is recomputed.
function rebuildTemplate() {
  const depth = Math.min(state.colourDepth, maxColourDepth());
  const mask = maskFor();
  const inlay = buildInlaySolid(surfaceOf(), mask, depth, state.cell);
  showDetailWarning(mask);

  lastBuild = { cover: template.positions, inlay };

  clearMesh();
  showInlay(inlay, -1);

  setStat('s-dims', `${mm(face.width)} × ${mm(face.height)} mm (fixo)`);
  setStat('s-tris', `${template.triangles.toLocaleString('pt-PT')} + ${(inlay.length / 9).toLocaleString('pt-PT')}`);
  setStat('s-size', `${((84 + template.triangles * 50) / 1048576).toFixed(1)} + ${((84 + (inlay.length / 9) * 50) / 1048576).toFixed(1)} MB`);
}

function rebuild() {
  if (isTemplate()) return rebuildTemplate();

  const depth = Math.max(state.wall + 0.6, state.depth);
  const totalDepth = state.style === 'shell' ? depth : state.wall;
  const topZ = state.style === 'shell' ? depth : state.wall;

  // The cover's face is flat: the design is a second body, not a displacement,
  // so the grid only has to describe the shape and can stay coarse.
  const built = buildCover({
    width: state.width,
    height: state.height,
    radius: state.radius,
    wall: state.wall,
    depth,
    style: state.style,
    stampDepth: 0,
    stampMode: 'raised',
    cell: 2,
    mask: null,
  });

  const colourDepth = Math.min(state.colourDepth, maxColourDepth());
  const mask = maskFor();
  const inlay = buildInlaySolid(surfaceOf(topZ), mask, colourDepth, state.cell);
  showDetailWarning(mask);

  lastBuild = { cover: built.positions, inlay };

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
  geom.computeVertexNormals();

  clearMesh();
  mesh = new THREE.Mesh(geom, material);
  holder.add(mesh);
  showInlay(inlay, 1);

  // Geometry runs z = 0 .. topZ; centre it so orbiting feels natural.
  holder.position.set(0, 0, -totalDepth / 2);
  modelRoot.rotation.y = 0;

  const inlayTris = inlay.length / 9;
  setStat('s-dims', `${state.width} × ${state.height} × ${totalDepth.toFixed(1)} mm`);
  setStat('s-tris', `${built.triangles.toLocaleString('pt-PT')} + ${inlayTris.toLocaleString('pt-PT')}`);
  setStat('s-size', `${((84 + built.triangles * 50) / 1048576).toFixed(1)} + ${((84 + inlayTris * 50) / 1048576).toFixed(1)} MB`);

  const warn = $('stamp-warn');
  if (state.colourDepth > maxColourDepth() + 1e-6) {
    warn.hidden = false;
    warn.textContent =
      `Limitada a ${maxColourDepth().toFixed(1)} mm — a cor não pode atravessar a espessura da capa.`;
  } else {
    warn.hidden = true;
  }
}

let pending = 0;
function scheduleRebuild() {
  $('busy').hidden = false;
  clearTimeout(pending);
  pending = setTimeout(() => {
    try {
      rebuild();
    } catch (err) {
      console.error(err);
    }
    $('busy').hidden = true;
    save();
    announce('bimby:change');
  }, 180);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function fetchModel(id) {
  if (modelCache.has(id)) return modelCache.get(id);
  const spec = modelSpec(id);
  if (!spec) throw new Error(`unknown model: ${id}`);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`${spec.url}: HTTP ${res.status}`);
  const parsed = parseSTL(await res.arrayBuffer());
  const entry = { spec, ...parsed, face: analyseFace(parsed.positions) };
  modelCache.set(id, entry);
  return entry;
}

function activate(entry) {
  template = entry;
  face = entry.face;
  model = entry.spec;
  state.model = entry.spec.id;
}

// Make one the active model. Throws if it cannot be fetched or parsed, leaving
// whatever was already loaded untouched.
async function useModel(id) {
  activate(await fetchModel(id));
}

// Attach or detach the template body and set the viewing transform.
function applyBase() {
  if (baseMesh) {
    baseMesh.geometry.dispose();
    holder.remove(baseMesh);
    baseMesh = null;
  }
  if (!isTemplate()) {
    modelRoot.rotation.y = 0;
    holder.position.set(0, 0, 0);
    return;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(template.positions, 3));
  geom.computeVertexNormals();
  baseMesh = new THREE.Mesh(geom, baseMaterial);
  holder.add(baseMesh);

  // The stamped face looks along -Z, so turn the part to face the camera and
  // recentre it — about the middle of the model's own thickness, whatever that
  // is. This is presentation only; exported coordinates are untouched.
  modelRoot.rotation.y = Math.PI;
  holder.position.set(-face.cx, -face.cy, -face.thickness / 2);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const SLIDERS = [
  ['f-width', 'o-width', 'width', (v) => `${v} mm`],
  ['f-height', 'o-height', 'height', (v) => `${v} mm`],
  ['f-radius', 'o-radius', 'radius', (v) => `${v} mm`],
  ['f-wall', 'o-wall', 'wall', (v) => `${v} mm`],
  ['f-depth', 'o-depth', 'depth', (v) => `${v} mm`],
  ['f-colour', 'o-colour', 'colourDepth', (v) => `${v} mm`],
];

const mm = (v) => v.toFixed(1).replace('.', ',');

// Which models the picker offers. Shop mode sells one model at a time and has
// no use for the parametric generator, so it gets a single fixed entry.
function modelChoices() {
  if (SHOP) return MODELS.filter((m) => m.id === state.model);
  return [...MODELS, { id: CUSTOM, label: 'Medidas próprias' }];
}

function fillModelSelect() {
  const sel = $('f-model');
  if (!sel) return;
  const choices = modelChoices();
  sel.innerHTML = '';
  for (const c of choices) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.label;
    sel.append(o);
  }
  // One choice is not a choice; the panel still shows which model it is.
  $('base-field').hidden = choices.length < 2;
}

function syncControls() {
  for (const [inp, out, key, fmt] of SLIDERS) {
    $(inp).value = state[key];
    $(out).textContent = fmt(state[key]);
  }
  $('f-quality').value = String(state.cell);
  for (const b of $('style-seg').children) b.classList.toggle('on', b.dataset.val === state.style);

  const tpl = isTemplate();
  const sel = $('f-model');
  if (sel) sel.value = tpl ? state.model : CUSTOM;

  // A supplied model's dimensions are fixed by the machine, so nothing that
  // would change them is offered while one is selected.
  $('custom-dims').hidden = tpl;
  $('template-info').hidden = !tpl;
  $('depth-field').hidden = tpl || state.style !== 'shell';

  if (tpl && face) {
    $('t-size').textContent =
      `${mm(face.width)} × ${mm(face.height)} × ${mm(face.thickness)} mm`;
    // A round face is a diameter, and quoting it as a square would understate
    // it by a third.
    $('t-area').textContent = face.round
      ? `Ø ${face.safeWidth.toFixed(0)} mm`
      : `${face.safeWidth.toFixed(0)} × ${face.safeHeight.toFixed(0)} mm`;
    $('t-note').textContent = face.round
      ? `${model.label}: medidas fixas, o desenho fica dentro do disco liso. `
        + 'A malha original não é alterada.'
      : `${model.label}: medidas fixas — a malha original não é alterada.`;
  }
}

for (const [inp, out, key, fmt] of SLIDERS) {
  $(inp).addEventListener('input', (e) => {
    state[key] = parseFloat(e.target.value);
    $(out).textContent = fmt(state[key]);
    scheduleRebuild();
  });
}

$('f-quality').addEventListener('change', (e) => {
  state.cell = parseFloat(e.target.value);
  scheduleRebuild();
});

// A model can still be on the wire when the next one is picked, and the two
// fetches need not land in order. Only the newest pick may take effect.
let picked = 0;

$('f-model')?.addEventListener('change', async (e) => {
  const want = e.target.value;
  if (want === (isTemplate() ? state.model : CUSTOM)) return;
  const token = ++picked;

  if (want !== CUSTOM) {
    // Hold the model already on screen until the new one lands, and put the
    // picker back if it never does.
    $('busy').hidden = false;
    let entry;
    try {
      entry = await fetchModel(want);
    } catch (err) {
      console.error('Model could not be loaded:', err);
      if (token !== picked) return;
      $('busy').hidden = true;
      syncControls();
      alert('Não foi possível carregar este modelo.');
      return;
    }
    if (token !== picked) return;
    activate(entry);
  }
  state.mode = want === CUSTOM ? CUSTOM : 'template';

  maskCache = { key: null, mask: null };
  clampLayers();
  applyBase();
  syncControls();
  renderLayerList();
  renderEditor();
  rebuild();
  frameCamera([0.55, 0.45, 0.85]);
  $('busy').hidden = true;
  save();
  announce('bimby:change');
});

$('style-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.style = b.dataset.val;
  syncControls();
  scheduleRebuild();
});

// ---------------------------------------------------------------------------
// Layer list
// ---------------------------------------------------------------------------

function renderLayerList() {
  const ul = $('layers');
  ul.innerHTML = '';
  $('layers-empty').hidden = layers.length > 0;

  layers.forEach((layer, i) => {
    const li = document.createElement('li');
    li.className = layer.id === selectedId ? 'sel' : '';

    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = layer.kind === 'text' ? 'T' : '🖼';

    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layer.kind === 'text' ? (layer.text.split('\n')[0] || 'Texto') : layer.name;

    li.append(ico, name);

    const mk = (label, title, fn, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.disabled = !!disabled;
      if (disabled) b.style.opacity = '.3';
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    li.append(
      mk(layer.visible === false ? '○' : '●', 'Mostrar/ocultar', () => {
        layer.visible = layer.visible === false;
        renderLayerList();
        scheduleRebuild();
      }),
      mk('↑', 'Subir', () => {
        [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]];
        renderLayerList();
        scheduleRebuild();
      }, i === 0),
      mk('↓', 'Descer', () => {
        [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]];
        renderLayerList();
        scheduleRebuild();
      }, i === layers.length - 1),
      mk('✕', 'Remover', () => {
        layers.splice(i, 1);
        if (selectedId === layer.id) selectedId = layers.length ? layers[0].id : null;
        renderLayerList();
        renderEditor();
        scheduleRebuild();
      }),
    );

    li.addEventListener('click', () => {
      selectedId = layer.id;
      renderLayerList();
      renderEditor();
    });

    ul.append(li);
  });
}

// ---------------------------------------------------------------------------
// Layer editor
// ---------------------------------------------------------------------------

function field(labelText, node, valueNode) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  if (valueNode) label.append(valueNode);
  wrap.append(label, node);
  return wrap;
}

function slider(layer, key, min, max, step, unit = 'mm') {
  const digits = step < 1 ? 1 : 0;
  const fmt = (v) => (unit ? `${v.toFixed(digits)} ${unit}` : v.toFixed(digits));

  const out = document.createElement('output');
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = min; inp.max = max; inp.step = step;
  inp.value = layer[key];
  out.textContent = fmt(+layer[key]);
  inp.addEventListener('input', () => {
    layer[key] = parseFloat(inp.value);
    out.textContent = fmt(layer[key]);
    scheduleRebuild();
  });
  return { inp, out };
}

function renderEditor() {
  const host = $('editor');
  const group = $('editor-group');
  host.innerHTML = '';

  const layer = layers.find((l) => l.id === selectedId);
  if (!layer) { group.hidden = true; return; }
  group.hidden = false;

  if (layer.kind === 'text') {
    const ta = document.createElement('textarea');
    ta.value = layer.text;
    ta.addEventListener('input', () => {
      layer.text = ta.value;
      renderLayerList();
      scheduleRebuild();
    });
    host.append(field('Texto', ta));

    const sel = document.createElement('select');
    for (const f of FONTS) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.label;
      o.style.fontFamily = f.css;
      sel.append(o);
    }
    sel.value = layer.font;
    sel.addEventListener('change', () => { layer.font = sel.value; scheduleRebuild(); });

    const wsel = document.createElement('select');
    for (const [v, l] of [[300, 'Fino'], [400, 'Normal'], [600, 'Semi-negrito'], [700, 'Negrito'], [900, 'Extra-negrito']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      wsel.append(o);
    }
    wsel.value = String(layer.weight);
    wsel.addEventListener('change', () => { layer.weight = parseInt(wsel.value, 10); scheduleRebuild(); });

    const row = document.createElement('div');
    row.className = 'row2';
    row.append(field('Tipo de letra', sel), field('Peso', wsel));
    host.append(row);

    const s1 = slider(layer, 'size', 3, 80, 0.5);
    host.append(field('Tamanho', s1.inp, s1.out));
    const s2 = slider(layer, 'tracking', -2, 12, 0.1);
    host.append(field('Espaçamento', s2.inp, s2.out));
    const s3 = slider(layer, 'lineGap', 0.8, 2.5, 0.05, '×');
    host.append(field('Entrelinha', s3.inp, s3.out));
  } else {
    const s1 = slider(layer, 'width', 5, 320, 1);
    host.append(field('Largura', s1.inp, s1.out));

    // silhouette() keys its cache on these three settings, so changing them
    // invalidates it on the next render without any explicit bookkeeping.
    const s2 = slider(layer, 'threshold', 0.05, 0.95, 0.01, '');
    host.append(field('Limiar', s2.inp, s2.out));

    const inv = document.createElement('label');
    inv.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = layer.invert;
    cb.addEventListener('change', () => {
      layer.invert = cb.checked;
      scheduleRebuild();
    });
    inv.append(cb, document.createTextNode('Inverter'));

    const alp = document.createElement('label');
    alp.className = 'check';
    const cb2 = document.createElement('input');
    cb2.type = 'checkbox';
    cb2.checked = layer.useAlpha;
    cb2.addEventListener('change', () => {
      layer.useAlpha = cb2.checked;
      scheduleRebuild();
    });
    alp.append(cb2, document.createTextNode('Usar transparência (PNG/SVG)'));

    host.append(inv, alp);
  }

  const area = designArea();
  const hw = area.w / 2;
  const hh = area.h / 2;
  const px = slider(layer, 'x', -hw, hw, 0.5);
  const py = slider(layer, 'y', -hh, hh, 0.5);
  const rot = slider(layer, 'rotation', -180, 180, 1, '°');

  const row = document.createElement('div');
  row.className = 'row2';
  row.append(field('Posição X', px.inp, px.out), field('Posição Y', py.inp, py.out));
  host.append(row, field('Rotação', rot.inp, rot.out));

  const center = document.createElement('button');
  center.type = 'button';
  center.className = 'btn btn-block';
  center.textContent = 'Centrar';
  center.addEventListener('click', () => {
    layer.x = 0;
    layer.y = 0;
    renderEditor();
    scheduleRebuild();
  });
  host.append(center);
}

// ---------------------------------------------------------------------------
// Adding layers
// ---------------------------------------------------------------------------

$('btn-add-text').addEventListener('click', () => {
  const l = makeTextLayer();
  layers.push(l);
  selectedId = l.id;
  renderLayerList();
  renderEditor();
  scheduleRebuild();
});

$('btn-add-image').addEventListener('click', () => $('file-image').click());

$('file-image').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const original = await readAsDataURL(file);
    const img = await loadImage(original);
    const layer = makeImageLayer(file.name, img, img.naturalWidth / img.naturalHeight);
    // Measured from the artwork itself, so a logo in more than one ink arrives
    // whole rather than losing whichever parts sit near the default cutoff.
    layer.threshold = autoThreshold(img);
    // Stamps are thresholded to a silhouette, so a downscaled copy loses
    // nothing and keeps the saved design inside the localStorage quota.
    layer.dataUrl = shrinkDataURL(img, original);
    layer.width = Math.min(designArea().w * 0.6, 80);
    layers.push(layer);
    selectedId = layer.id;
    renderLayerList();
    renderEditor();
    scheduleRebuild();
  } catch (err) {
    console.error(err);
    alert('Não foi possível carregar a imagem.');
  }
});

function shrinkDataURL(img, fallback, maxDim = 768) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return fallback;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1 && fallback.length < 400_000) return fallback;

  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  try {
    // PNG keeps the alpha channel, which drives the silhouette for logos.
    const out = c.toDataURL('image/png');
    return out.length < fallback.length ? out : fallback;
  } catch {
    return fallback;
  }
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ---------------------------------------------------------------------------
// Views / export
// ---------------------------------------------------------------------------

function frameCamera(pos) {
  // Fit the bounding sphere, so the cover stays framed from any angle.
  const depth = isTemplate()
    ? face.thickness
    : (state.style === 'shell' ? Math.max(state.wall + 0.6, state.depth) : state.wall);
  const w = isTemplate() ? face.width : state.width;
  const h = isTemplate() ? face.height : state.height;
  const radius = Math.hypot(w / 2, h / 2, depth) * 1.08;
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);

  camera.position.copy(new THREE.Vector3(...pos).normalize().multiplyScalar(dist));
  controls.target.set(0, 0, 0);
  controls.update();
}

$('btn-view-front').addEventListener('click', () => frameCamera([0, 0, 1]));
$('btn-view-iso').addEventListener('click', () => frameCamera([0.55, 0.45, 0.85]));
$('btn-view-back').addEventListener('click', () => frameCamera([0, 0, -1]));

$('btn-wire').addEventListener('click', (e) => {
  material.wireframe = !material.wireframe;
  e.currentTarget.classList.toggle('on', material.wireframe);
});

// Two filaments means two bodies, and they have to stay separate files: STL
// carries no notion of parts or colour, so anything merged into one file would
// print in a single colour. Load both into the slicer as one object with two
// parts — they share a coordinate system, so they land aligned — then assign a
// filament to each.
function exportCover() {
  if (SHOP || !lastBuild) return;
  // The template's own records are copied through byte for byte rather than
  // re-encoded, so the measured mesh survives exactly.
  const { buffer } = isTemplate()
    ? buildExportSTL(template.source, template.triangles, null, slug())
    : trianglesToSTL(lastBuild.cover, slug());
  downloadBlob(new Blob([buffer], { type: 'model/stl' }), `${slug()}-preto.stl`);
}

function exportInlay() {
  if (SHOP || !lastBuild || !lastBuild.inlay.length) return;
  const { buffer } = trianglesToSTL(lastBuild.inlay, `desenho ${slug()}`);
  downloadBlob(new Blob([buffer], { type: 'model/stl' }), `${slug()}-desenho-branco.stl`);
}

$('btn-cover')?.addEventListener('click', exportCover);
$('btn-cover-2')?.addEventListener('click', exportCover);
$('btn-design')?.addEventListener('click', exportInlay);
$('btn-design-2')?.addEventListener('click', exportInlay);

$('btn-snapshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  canvas.toBlob((b) => b && downloadBlob(b, 'capa-bimby-previsualizacao.png'), 'image/png');
});

$('btn-reset')?.addEventListener('click', () => {
  if (!confirm('Repor todas as definições e remover as camadas?')) return;
  state = { ...DEFAULTS };
  layers = [];
  selectedId = null;
  localStorage.removeItem(STORE_KEY);
  syncControls();
  renderLayerList();
  renderEditor();
  scheduleRebuild();
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function serializeLayer(l) {
  const { src, _cache, ...rest } = l;
  return rest;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      state,
      layers: layers.map(serializeLayer),
    }));
  } catch { /* quota or private mode — not worth interrupting the user */ }
}

async function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch { return false; }
  if (!raw) return false;

  try {
    const data = JSON.parse(raw);
    state = { ...DEFAULTS, ...data.state };
    layers = [];
    for (const l of data.layers || []) {
      if (l.kind === 'image') {
        if (!l.dataUrl) continue;
        l.src = await loadImage(l.dataUrl);
        l._cache = null;
      }
      layers.push(l);
    }
    selectedId = layers.length ? layers[0].id : null;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integration surface
//
// What a shop needs from the configurator is the *rasterised mask*, not the
// finished STL: the mask is what makes the print match the preview the
// customer approved, and it keeps the model file on the seller's side.
// ---------------------------------------------------------------------------

window.BimbyCover = {
  get ready() {
    return Boolean(lastBuild);
  },

  /** The current design, ready to POST to the order backend. */
  getDesign() {
    const mask = maskFor();
    if (!mask) return null;
    renderer.render(scene, camera);
    return {
      config: {
        mode: state.mode,
        model: isTemplate() ? state.model : null,
        colourDepth: state.colourDepth,
        cell: state.cell,
        layers: layers.map(serializeLayer),
      },
      maskPng: mask.canvas.toDataURL('image/png'),
      previewPng: canvas.toDataURL('image/png'),
    };
  },
};

// A shop embeds this page in an iframe, so the same API is reachable by
// postMessage. Replies go back only to the window and origin that asked.
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'bimby:getDesign' || !event.source) return;
  let design = null;
  try {
    design = window.BimbyCover.getDesign();
  } catch (err) {
    console.error(err);
  }
  const target = event.origin && event.origin !== 'null' ? event.origin : '*';
  event.source.postMessage({ type: 'bimby:design', requestId: msg.requestId, design }, target);
});

// Nothing identifying here, just "there is something to buy" — safe to
// broadcast so the host page can enable its button.
function announce(type) {
  if (window.parent === window) return;
  window.parent.postMessage({
    type,
    hasDesign: layers.some((l) => l.visible !== false),
    mode: state.mode,
    model: isTemplate() ? state.model : null,
  }, '*');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applyEmbedMode() {
  if (EMBED) document.body.classList.add('embed');
  if (!SHOP) return;

  document.body.classList.add('shop');
  // A shop sells one model per page — ?model= picks which — so the parametric
  // generator has nothing to offer here, and triangle counts are not something
  // a shopper needs. modelChoices() narrows the picker to match.
  state.mode = 'template';
  for (const el of [$('btn-cover'), $('btn-design'), $('result-group')]) {
    if (el) el.remove();
  }
}

// Open on the model the URL asked for, else the one last used, else the first
// that loads at all. Custom mode is the fallback if none of them do.
//
// A shop page is the exception: it sells one specific product, and quietly
// serving a different one would be worse than serving none.
async function bootModel(preferred) {
  const order = SHOP
    ? [preferred]
    : [...new Set([preferred, ...MODELS.map((m) => m.id)])].filter(Boolean);
  for (const id of order) {
    try {
      await useModel(id);
      return true;
    } catch (err) {
      console.error(`Model ${id} could not be loaded:`, err);
    }
  }
  return false;
}

(async function boot() {
  // Restore before fetching: the saved design says which model to open, and
  // the meshes are large enough that fetching the wrong one is worth avoiding.
  const restored = await load();
  applyEmbedMode();

  // A shop page sells one product; without ?model= it is the first one, never
  // whatever the visitor happened to configure last.
  const loaded = await bootModel(WANTED_MODEL || (SHOP ? MODELS[0].id : state.model));
  if (!loaded) state.mode = CUSTOM;
  if (SHOP && !loaded) {
    // Nothing to sell without a model; better to say so than to offer sizes.
    console.error('Shop mode needs a model and none could be loaded.');
  }

  if (!restored) {
    const l = makeTextLayer();
    layers = [l];
    selectedId = l.id;
  }
  if (state.mode === 'template' && !template) state.mode = CUSTOM;
  clampLayers();

  fillModelSelect();
  applyBase();
  syncControls();
  renderLayerList();
  renderEditor();
  resize();
  frameCamera([0.55, 0.45, 0.85]);
  rebuild();
  $('busy').hidden = true;
  animate();
  announce('bimby:ready');
})();

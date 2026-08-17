import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCover } from './geom.js';
import { renderMask, makeTextLayer, makeImageLayer, FONTS } from './stamp.js';
import { trianglesToSTL, downloadBlob } from './stl.js';
import { parseSTL, analyseFace, buildStampSolid, buildExportSTL } from './template.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'bimby-cover-v1';
const TEMPLATE_URL = 'assets/model/tm7-cover.stl';

// Embedding options, read from the query string.
//   ?embed=1  drop the page's own header — the host page has its own
//   ?shop=1   selling context: no STL download, template only
// Handing a shopper the STL would give away the product, so shop mode removes
// every route to it rather than merely hiding the buttons.
const params = new URLSearchParams(location.search);
const EMBED = params.has('embed') || params.has('shop');
const SHOP = params.has('shop');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'template',
  style: 'shell',
  width: 230,
  height: 150,
  radius: 10,
  wall: 2,
  depth: 12,
  stampMode: 'raised',
  stampDepth: 1,
  cell: 0.7,
};

let state = { ...DEFAULTS };
let layers = [];
let selectedId = null;

// The supplied TM7 template: its triangles and the flat face we stamp on.
let template = null;   // { positions, triangles }
let face = null;       // analyseFace() result

const isTemplate = () => state.mode === 'template' && template;

// Millimetres of design area available, whichever mode is active.
function designArea() {
  return isTemplate()
    ? { w: face.safeWidth, h: face.safeHeight }
    : { w: state.width, h: state.height };
}

// Minimum material left under an engraved stamp.
const MIN_FLOOR = 0.4;

function maxStampDepth() {
  // Template mode only adds material, so there is no floor to protect.
  if (isTemplate() || state.stampMode !== 'engraved') return 4;
  return Math.max(0.2, state.wall - MIN_FLOOR);
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------

const canvas = $('canvas');
const viewport = $('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11151b);

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

scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x1a1f26, 1.15));

const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.4, 0.8, 1);
scene.add(key);

const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
fill.position.set(-0.8, -0.3, 0.6);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 0.7);
rim.position.set(0, 0.2, -1);
scene.add(rim);

const material = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.58,
  metalness: 0.04,
});

const baseMaterial = new THREE.MeshStandardMaterial({
  color: 0x9fb0c4, roughness: 0.6, metalness: 0.04,
});

const stampMaterial = new THREE.MeshStandardMaterial({
  color: 0x4da3ff, roughness: 0.45, metalness: 0.05,
});

// modelRoot orients the whole cover; holder recentres it so orbiting spins
// about the middle of the part rather than the STL's own origin.
const modelRoot = new THREE.Group();
scene.add(modelRoot);
const holder = new THREE.Group();
modelRoot.add(holder);

let mesh = null;        // parametric cover, or the stamp slab in template mode
let baseMesh = null;    // the untouched template body
let lastBuild = null;

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

const BASE = new THREE.Color(0x9fb0c4);
const ACCENT = new THREE.Color(0x4da3ff);

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

// Shop mode strips the results panel, so writing a stat is best-effort.
function setStat(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function clearMesh() {
  if (mesh) {
    mesh.geometry.dispose();
    holder.remove(mesh);
    mesh = null;
  }
}

// Template mode: the STL body is shown as-is and the design is a separate
// solid laid on its outward face. Nothing about the template is recomputed.
function rebuildTemplate() {
  const height = Math.min(state.stampDepth, 4);
  const slab = buildStampSolid(face, maskFor(), height, state.cell);

  lastBuild = { positions: slab, triangles: slab.length / 9 };

  clearMesh();
  if (slab.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(slab, 3));
    geom.computeVertexNormals();
    mesh = new THREE.Mesh(geom, stampMaterial);
    holder.add(mesh);
  }

  const total = template.triangles + slab.length / 9;
  setStat('s-dims', `${face.width.toFixed(1)} × ${face.height.toFixed(1)} mm (fixo)`);
  setStat('s-tris', total.toLocaleString('pt-PT'));
  setStat('s-size', `~${((84 + total * 50) / 1048576).toFixed(1)} MB`);
  $('stamp-warn').hidden = true;
}

function rebuild() {
  if (isTemplate()) return rebuildTemplate();

  const depth = Math.max(state.wall + 0.6, state.depth);
  const stampDepth = Math.min(state.stampDepth, maxStampDepth());

  const built = buildCover({
    width: state.width,
    height: state.height,
    radius: state.radius,
    wall: state.wall,
    depth,
    style: state.style,
    stampDepth,
    stampMode: state.stampMode,
    cell: state.cell,
    mask: maskFor(),
  });

  lastBuild = built;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));

  // Tint the stamped areas so the design reads clearly in the preview.
  const colors = new Float32Array(built.amounts.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < built.amounts.length; i++) {
    const a = built.amounts[i];
    const t = a <= 0.35 ? 0 : a >= 0.65 ? 1 : (a - 0.35) / 0.3;
    c.copy(BASE).lerp(ACCENT, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  clearMesh();
  mesh = new THREE.Mesh(geom, material);
  holder.add(mesh);
  // Geometry runs z = 0 .. topZ; centre it so orbiting feels natural.
  const totalDepth = state.style === 'shell' ? depth : state.wall;
  holder.position.set(0, 0, -totalDepth / 2);
  modelRoot.rotation.y = 0;

  setStat('s-dims', `${state.width} × ${state.height} × ${totalDepth.toFixed(1)} mm`);
  setStat('s-tris', built.triangles.toLocaleString('pt-PT'));
  setStat('s-size', `~${((84 + built.triangles * 50) / 1048576).toFixed(1)} MB`);

  const warn = $('stamp-warn');
  if (state.stampMode === 'engraved' && state.stampDepth > maxStampDepth() + 1e-6) {
    warn.hidden = false;
    warn.textContent =
      `Limitado a ${maxStampDepth().toFixed(1)} mm para deixar ${MIN_FLOOR} mm de material sob o gravado.`;
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
// Template
// ---------------------------------------------------------------------------

async function loadTemplate() {
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error(`template HTTP ${res.status}`);
  template = parseSTL(await res.arrayBuffer());
  face = analyseFace(template.positions);
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
  // recentre it. This is presentation only — exported coordinates are untouched.
  modelRoot.rotation.y = Math.PI;
  holder.position.set(-face.cx, -face.cy, -5);
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
  ['f-stamp', 'o-stamp', 'stampDepth', (v) => `${v} mm`],
];

function syncControls() {
  for (const [inp, out, key, fmt] of SLIDERS) {
    $(inp).value = state[key];
    $(out).textContent = fmt(state[key]);
  }
  $('f-quality').value = String(state.cell);
  for (const b of $('style-seg').children) b.classList.toggle('on', b.dataset.val === state.style);
  for (const b of $('mode-seg').children) b.classList.toggle('on', b.dataset.val === state.stampMode);
  const baseSeg = $('base-seg');
  if (baseSeg) {
    for (const b of baseSeg.children) b.classList.toggle('on', b.dataset.val === state.mode);
  }

  const tpl = isTemplate();
  // The template's dimensions are fixed by the machine, so nothing that would
  // change them is offered while it is selected.
  $('custom-dims').hidden = tpl;
  $('template-info').hidden = !tpl;
  $('mode-field').hidden = tpl;
  $('depth-field').hidden = tpl || state.style !== 'shell';
  $('stamp-label').textContent = tpl ? 'Altura do relevo' : 'Altura do relevo';

  if (tpl && face) {
    $('t-size').textContent = `${face.width.toFixed(1)} × ${face.height.toFixed(1)} × 10,0 mm`;
    $('t-area').textContent = `${face.safeWidth.toFixed(0)} × ${face.safeHeight.toFixed(0)} mm`;
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

$('base-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.val === state.mode) return;
  state.mode = b.dataset.val;
  maskCache = { key: null, mask: null };
  applyBase();
  syncControls();
  renderEditor();
  rebuild();
  frameCamera([0.55, 0.45, 0.85]);
  save();
});

$('style-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.style = b.dataset.val;
  syncControls();
  scheduleRebuild();
});

$('mode-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.stampMode = b.dataset.val;
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
    // Stamps are thresholded to a silhouette, so a downscaled copy loses
    // nothing and keeps the saved design inside the localStorage quota.
    layer.dataUrl = shrinkDataURL(img, original);
    layer.width = Math.min(state.width * 0.6, 80);
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
    ? 10
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

function exportSTL() {
  // Belt and braces: the buttons are gone in shop mode, but the function is
  // reachable from the console, and the model is the thing being sold.
  if (SHOP || !lastBuild) return;

  // In template mode the supplied records are copied through byte for byte and
  // the design is appended as a second body for the slicer to union.
  const { buffer, triangles } = isTemplate()
    ? buildExportSTL(template.source, template.triangles, lastBuild.positions, 'bimby tm7 cover')
    : trianglesToSTL(lastBuild.positions, 'bimby tm7 cover');

  $('s-tris').textContent = triangles.toLocaleString('pt-PT');
  $('s-size').textContent = `${(buffer.byteLength / 1048576).toFixed(1)} MB`;
  downloadBlob(new Blob([buffer], { type: 'model/stl' }), 'capa-bimby-tm7.stl');
}

$('btn-stl')?.addEventListener('click', exportSTL);
$('btn-stl-2')?.addEventListener('click', exportSTL);

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
        relief: state.stampDepth,
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
  }, '*');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applyEmbedMode() {
  if (EMBED) document.body.classList.add('embed');
  if (!SHOP) return;

  document.body.classList.add('shop');
  // Only the template is a product, so the base switch has nothing to offer,
  // and triangle counts are not something a shopper needs.
  state.mode = 'template';
  for (const el of [$('btn-stl'), $('base-field'), $('result-group')]) {
    if (el) el.remove();
  }
}

(async function boot() {
  applyEmbedMode();
  try {
    await loadTemplate();
  } catch (err) {
    console.error('Template could not be loaded:', err);
    state.mode = 'custom';
    if ($('base-seg')) $('base-seg').hidden = true;
  }

  const restored = await load();
  if (!restored) {
    const l = makeTextLayer();
    layers = [l];
    selectedId = l.id;
  }
  if (state.mode === 'template' && !template) state.mode = 'custom';

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

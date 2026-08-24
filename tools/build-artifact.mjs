// Build the single-file, offline copy of the configurator that gets published
// as a Claude Artifact.
//
//   npm install && npm run artifact
//
// An artifact is one HTML file behind a strict CSP: no CDN, no fetches to
// other hosts, no sibling assets. So three.js, the app, the stylesheet and
// every model STL all end up inside the page.
//
// Nothing in assets/ is modified to make this work. Two things differ in the
// published copy, and both are arranged from here rather than by adding modes
// to the app:
//
//   - The app fetches models by URL. There is no server, so `fetch` is shimmed
//     to answer those requests from embedded copies.
//   - The artifact viewer's save allowlist has no `.stl` entry, so the STL
//     buttons are hidden and the preview PNG is offered instead, through the
//     viewer's own downloads capability.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(REPO, 'dist', 'capa-tm7-artifact.html');

const TITLE = 'Personalizador de Capa TM7';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const css = readFileSync(join(REPO, 'assets/css/style.css'), 'utf8');
const html = readFileSync(join(REPO, 'index.html'), 'utf8');

// Every model the app offers has to travel with it. The names are matched
// against the app's own fetch URLs, so this list must track the MODELS
// registry in assets/js/app.js.
const MODEL_FILES = ['tm7-cover.stl', 'tm7-base.stl'];
const models = MODEL_FILES.map((name) => ({
  name,
  b64: readFileSync(join(REPO, 'assets/model', name)).toString('base64'),
}));
const stlB64Len = models.reduce((n, m) => n + m.b64.length, 0);

// The app's own markup, minus its module script — the bundle replaces that.
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

const built = await esbuild.build({
  entryPoints: [join(REPO, 'assets/js/app.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  alias: {
    three: join(REPO, 'vendor/three.module.js'),
    'three/addons/controls/OrbitControls.js': join(REPO, 'vendor/OrbitControls.js'),
  },
});
const bundle = built.outputFiles[0].text;

// ---------------------------------------------------------------------------
// Artifact-only framing
// ---------------------------------------------------------------------------

const framing = `
/* ---- artifact framing -------------------------------------------------
   Committed to a single dark treatment: the page is an instrument panel with
   a lit 3D stage in it, and light chrome around a dark viewport reads as two
   designs stuck together. Every colour is painted explicitly, so the page
   never borrows the host's ground.  */

:root {
  --af-ground: #0b0e12;
  --af-surface: #141920;
  --af-line: #242c36;
  --af-ink: #e4ebf2;
  --af-muted: #7e8b9a;
  --af-accent: #4da3ff;
  --af-amber: #ffb454;
  --af-mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

body { background: var(--af-ground); color: var(--af-ink); }

/* Every route to an STL: the viewer cannot save one, so none is offered. */
.topbar, #btn-cover-2, #btn-design-2 { display: none !important; }

.af-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 11px 18px;
  background: var(--af-surface);
  border-bottom: 1px solid var(--af-line);
}

.af-name { display: flex; align-items: baseline; gap: 10px; min-width: 0; }

.af-name b {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.af-name span {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--af-muted);
  white-space: nowrap;
}

.af-spec {
  margin-left: auto;
  display: flex;
  gap: 16px;
  font-family: var(--af-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--af-muted);
}

.af-spec b { color: var(--af-ink); font-weight: 500; }

.af-save {
  background: transparent;
  color: var(--af-ink);
  border: 1px solid var(--af-line);
  border-radius: 8px;
  padding: 6px 12px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.af-save:hover:not(:disabled) { border-color: var(--af-accent); color: var(--af-accent); }
.af-save:disabled { opacity: .45; cursor: default; }
.af-save:focus-visible { outline: 2px solid var(--af-accent); outline-offset: 2px; }

.af-note {
  flex: 0 0 auto;
  display: flex;
  gap: 9px;
  align-items: baseline;
  padding: 8px 18px;
  background: #1a1710;
  border-bottom: 1px solid #33291a;
  color: #d9c49a;
  font-size: 12.5px;
  line-height: 1.45;
}

.af-note i { color: var(--af-amber); font-style: normal; }

@media (max-width: 700px) {
  .af-spec { margin-left: 0; width: 100%; }
}
`;

const glue = `
// No server here, so the models travel inside the page and the app's fetches
// for them are answered from memory. Everything else falls through. Decoding
// is deferred until a model is actually picked, so opening the page only pays
// for the one it starts on.
(function () {
  var B64 = {
${models.map((m) => `    ${JSON.stringify(m.name)}: "${m.b64}"`).join(',\n')}
  };
  function toBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var href = String(url);
    for (var name in B64) {
      if (href.indexOf(name) !== -1) {
        return Promise.resolve(new Response(toBytes(B64[name]).buffer));
      }
    }
    return realFetch(url, opts);
  };
})();
`;

const wiring = `
// Saving runs through the viewer's downloads capability, which asks before
// writing anything and can decline. It is absent in some views, so the button
// only appears once we know it will work.
(function () {
  var btn = document.getElementById('af-save');
  var note = document.getElementById('af-note-text');

  function dataUrlToBytes(dataUrl) {
    var bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function downloads() {
    try {
      return (typeof claude !== 'undefined' && claude.use)
        ? await claude.use('downloads')
        : null;
    } catch (e) {
      return null;
    }
  }

  downloads().then(function (dl) {
    if (!dl) { btn.remove(); return; }
    btn.disabled = false;
    btn.addEventListener('click', async function () {
      var design = window.BimbyCover && window.BimbyCover.getDesign();
      if (!design) {
        note.textContent = 'Adicione texto ou uma imagem antes de guardar.';
        return;
      }
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'A guardar\\u2026';
      try {
        await dl.save({
          filename: 'capa-bimby-tm7.png',
          data: dataUrlToBytes(design.previewPng),
        });
      } catch (err) {
        if (err && err.code !== 'declined') {
          note.textContent = 'Nao foi possivel guardar a imagem (' + (err.code || 'erro') + ').';
        }
      } finally {
        btn.textContent = label;
        btn.disabled = false;
      }
    });
  });
})();
`;

// ---------------------------------------------------------------------------
// Compose
//
// The host wraps this in <!doctype html><head></head><body>, so the file holds
// page content only — no html/head/body tags of its own.
// ---------------------------------------------------------------------------

const page = `<title>${TITLE}</title>
<style>
${css}
${framing}
</style>

<header class="af-bar">
  <div class="af-name">
    <b>Personalizador de Capa</b>
    <span>Bimby TM7</span>
  </div>
  <div class="af-spec">
    <span>Modelos <b>capa do ecr&atilde; &middot; base</b></span>
    <span>Espessura da cor <b>0,2 &ndash; 4 mm</b></span>
  </div>
  <button type="button" class="af-save" id="af-save" disabled>Guardar imagem</button>
</header>

<div class="af-note">
  <i>&#9679;</i>
  <p id="af-note-text" style="margin:0">
    Vers&atilde;o de demonstra&ccedil;&atilde;o, para experimentar o personalizador.
    O ficheiro STL n&atilde;o pode ser descarregado aqui &mdash; a galeria de
    artefactos s&oacute; aceita alguns tipos de ficheiro, e <code>.stl</code>
    n&atilde;o &eacute; um deles. A vers&atilde;o completa, que gera o STL,
    corre a partir do reposit&oacute;rio.
  </p>
</div>

${body}

<script>
${glue}
</script>
<script>
${bundle}
</script>
<script>
${wiring}
</script>
`;

// ---------------------------------------------------------------------------
// Checks worth failing the build over
// ---------------------------------------------------------------------------

const problems = [];

if (/<\/?(html|head|body)\b|<!doctype/i.test(body)) {
  problems.push('app markup contains a document-level tag; the host supplies those');
}
// Anything pointing at another origin would be blocked by the artifact CSP.
for (const m of page.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)) {
  problems.push(`external reference: ${m[0].slice(0, 80)}`);
}
if (!page.includes(`<title>${TITLE}</title>`)) problems.push('missing <title>');
if (page.length > 16 * 1024 * 1024) problems.push('over the 16 MB artifact limit');

if (problems.length) {
  console.error('build failed:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(`wrote ${OUT}`);
console.log(`  total    ${(page.length / 1048576).toFixed(2)} MB`);
console.log(`  bundle   ${kb(bundle.length)}   (three.js + app, tree-shaken)`);
console.log(`  models   ${kb(stlB64Len)}   (${models.length} STLs, base64)`);
console.log(`  css      ${kb(css.length + framing.length)}`);
console.log('\nPublish with the Artifact tool: favicon 🍲, capabilities {"downloads": true}');

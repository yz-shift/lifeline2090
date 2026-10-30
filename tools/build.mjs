// Build dist/: bundle src/main.js -> dist/app.js, inline src/ui/styles.css into dist/index.html, copy data files.
// Usage: node tools/build.mjs [--watch]
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(join(dist, 'data'), { recursive: true });

function writeHtml() {
  const tpl = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  const uiDir = join(root, 'src', 'ui');
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const cssFiles = walk(uiDir).filter((p) => p.endsWith('.css')).sort((a, b) => (a.endsWith('styles.css') ? -1 : b.endsWith('styles.css') ? 1 : a.localeCompare(b)));
  const css = cssFiles.map((p) => '/* ' + p.slice(root.length + 1).split('\\').join('/') + ' */\n' + readFileSync(p, 'utf8')).join('\n');
  const html = tpl.replace('/*__STYLES__*/', css);
  writeFileSync(join(dist, 'index.html'), html);
  for (const f of ['countries.json', 'mortality.json', 'content.json']) {
    const src = join(root, 'data', f);
    if (existsSync(src)) copyFileSync(src, join(dist, 'data', f));
  }
  // the example content (social/seed.js) ships only with the standalone site; an empty file avoids a 404 elsewhere
  writeFileSync(join(dist, 'data', 'seed.json'), '{"lives":[],"stories":[]}');
}

const opts = {
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: join(dist, 'app.js'),
  sourcemap: false,
  minify: process.argv.includes('--minify'),
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context({ ...opts, plugins: [{ name: 'html', setup(b) { b.onEnd(() => writeHtml()); } }] });
  await ctx.watch();
} else {
  await build(opts);
  writeHtml();
  console.log('built dist/');
}

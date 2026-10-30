// Standalone website build: dist/ -> dist-web/ (GitHub Pages / any static host).
// Wraps the artifact page in a full HTML document (charset, viewport, language) and bundles the example content
// (web_seed/seed.json + images) that the claude.ai version keeps in its shared database.
// Usage: node tools/build.mjs && node tools/build_web.mjs   (then commit and push inside dist-web/ to publish)
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const web = join(root, 'dist-web');
if (!existsSync(join(dist, 'app.js'))) throw new Error('run node tools/build.mjs first');

// empty dist-web/ but keep its .git: the folder is the working copy of the published GitHub Pages repository
mkdirSync(web, { recursive: true });
for (const f of readdirSync(web)) if (f !== '.git') rmSync(join(web, f), { recursive: true, force: true });
mkdirSync(join(web, 'data'), { recursive: true });
mkdirSync(join(web, 'seed'), { recursive: true });
cpSync(join(dist, 'app.js'), join(web, 'app.js'));
for (const f of readdirSync(join(dist, 'data'))) copyFileSync(join(dist, 'data', f), join(web, 'data', f));

const page = readFileSync(join(dist, 'index.html'), 'utf8');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="人生长河：从 2000 年出生，按真实数据与历史走过一生，2027 年后进入依据今天趋势推演的世界线。">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${page}
</body>
</html>
`;
writeFileSync(join(web, 'index.html'), html);

const seedDir = join(root, 'web_seed');
if (existsSync(join(seedDir, 'seed.json'))) {
  copyFileSync(join(seedDir, 'seed.json'), join(web, 'data', 'seed.json'));
  for (const f of readdirSync(join(seedDir, 'img'))) copyFileSync(join(seedDir, 'img', f), join(web, 'seed', f));
}
writeFileSync(join(web, '.nojekyll'), '');
console.log('built dist-web/');

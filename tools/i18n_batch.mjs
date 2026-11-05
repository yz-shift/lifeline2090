// Translation workflow around i18n/source.json and i18n/en/<area>.json ({ zh: en }).
//   node tools/i18n_batch.mjs status
//   node tools/i18n_batch.mjs next <area> <count> [--out file]  prints "n|zh" for strings not translated yet
//   node tools/i18n_batch.mjs apply <area> <file>               reads "n|en" lines answering that batch
//   node tools/i18n_batch.mjs build                             validates everything and writes data/i18n_en.json
// In batch lines a newline inside a string is written as \n. A batch is remembered in i18n/.batch/<area>.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u4e00-\u9fff]/;
const enPath = (area) => join(root, 'i18n/en', `${area}.json`);
const batchPath = (area) => join(root, 'i18n/.batch', `${area}.json`);
const readJson = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const source = () => readJson(join(root, 'i18n/source.json'), {});
const holders = (s) => (s.match(/\{\w+\}/g) || []).slice().sort().join(',');
const flat = (s) => s.split('\n').join('\\n');

const [cmd, area, arg, ...rest] = process.argv.slice(2);

if (cmd === 'status') {
  let done = 0, all = 0;
  for (const [a, list] of Object.entries(source())) {
    const en = readJson(enPath(a), {});
    const left = list.filter((s) => !(s in en));
    const zh = left.join('').match(/[\u4e00-\u9fff]/g)?.length || 0;
    done += list.length - left.length;
    all += list.length;
    console.log(a.padEnd(20), `${list.length - left.length}/${list.length}`.padStart(13), `zh left ${zh}`);
  }
  console.log(`total ${done}/${all}`);
} else if (cmd === 'next') {
  const en = readJson(enPath(area), {});
  const todo = source()[area].filter((s) => !(s in en)).slice(0, Number(arg) || 200);
  mkdirSync(join(root, 'i18n/.batch'), { recursive: true });
  writeFileSync(batchPath(area), JSON.stringify(todo));
  const text = todo.map((s, i) => `${i}|${flat(s)}`).join('\n') + '\n';
  const o = rest.indexOf('--out');
  if (o >= 0) writeFileSync(rest[o + 1], text);
  else process.stdout.write(text);
} else if (cmd === 'apply') {
  const batch = readJson(batchPath(area), []);
  const en = readJson(enPath(area), {});
  const problems = [];
  let applied = 0;
  for (const line of readFileSync(arg, 'utf8').split('\n')) {
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (!m) { if (line.trim()) problems.push(`bad line: ${line.slice(0, 60)}`); continue; }
    const zh = batch[Number(m[1])];
    const text = m[2].split('\\n').join('\n').trim();
    if (zh === undefined) { problems.push(`no string ${m[1]}`); continue; }
    if (CJK.test(text)) { problems.push(`${m[1]}: still has Chinese`); continue; }
    if (holders(zh) !== holders(text)) { problems.push(`${m[1]}: placeholders ${holders(zh)} vs ${holders(text)}`); continue; }
    en[zh] = text;
    applied++;
  }
  mkdirSync(join(root, 'i18n/en'), { recursive: true });
  writeFileSync(enPath(area), JSON.stringify(en, null, 0).replace(/","/g, '",\n"') + '\n');
  console.log(`applied ${applied}/${batch.length}`);
  if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
} else if (cmd === 'build') {
  const out = {};
  const bad = [];
  for (const f of readdirSync(join(root, 'i18n/en')).filter((n) => n.endsWith('.json'))) {
    for (const [zh, en] of Object.entries(readJson(join(root, 'i18n/en', f), {}))) {
      if (CJK.test(en) || holders(zh) !== holders(en)) bad.push(`${f}: ${zh.slice(0, 40)}`);
      else out[zh] = en;
    }
  }
  writeFileSync(join(root, 'data/i18n_en.json'), JSON.stringify(out));
  console.log(`data/i18n_en.json: ${Object.keys(out).length} strings`);
  if (bad.length) { console.log(bad.join('\n')); process.exitCode = 1; }
} else {
  console.log('usage: status | next <area> <count> | apply <area> <file> | build');
}

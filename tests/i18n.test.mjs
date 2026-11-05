// English layer: lookup order, templates, fallbacks, and that the catalog is well formed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { setCatalog, forceLang, tr } from '../src/i18n/index.js';

function withCatalog(map, fn) {
  setCatalog(map);
  forceLang('en');
  try { fn(); } finally { forceLang('zh'); setCatalog({}); }
}

test('Chinese mode returns text untouched', () => {
  setCatalog({ 你好: 'Hello' });
  forceLang('zh');
  assert.equal(tr('你好'), '你好');
  setCatalog({});
});

test('exact match and non-Chinese passthrough', () => {
  withCatalog({ 你好: 'Hello' }, () => {
    assert.equal(tr('你好'), 'Hello');
    assert.equal(tr('Already English 123'), 'Already English 123');
    assert.equal(tr(''), '');
  });
});

test('template captures are translated and can be reordered', () => {
  withCatalog({ '{0}从{1}来。': '{1} is where {0} came from.', 中国: 'China', 小明: 'Ming' }, () => {
    assert.equal(tr('小明从中国来。'), 'China is where Ming came from.');
  });
});

test('named placeholders work like numbered ones', () => {
  withCatalog({ '{name}离开了{country}': '{name} left {country}', 巴西: 'Brazil' }, () => {
    assert.equal(tr('Ana离开了巴西'), 'Ana left Brazil');
  });
});

test('a one-character template only accepts non-Chinese captures', () => {
  withCatalog({ '{0} 个': '{0} items', 猫: 'cat' }, () => {
    assert.equal(tr('12 个'), '12 items');
    assert.match(tr('猫 个'), /猫/);
  });
});

test('joined sentences are translated one by one', () => {
  withCatalog({ '你毕业了。': 'You graduated.', '你结婚了。': 'You married.' }, () => {
    assert.equal(tr('你毕业了。你结婚了。'), 'You graduated. You married.');
  });
});

test('the longest template wins over a generic one', () => {
  withCatalog({ '{0}的工作': "{0}'s job", '{0}的新工作': "{0}'s new job", 你: 'you' }, () => {
    assert.equal(tr('你的新工作'), "you's new job");
  });
});

test('Chinese number units become English ones', () => {
  withCatalog({}, () => {
    assert.equal(tr('3.4亿'), '340M');
    assert.equal(tr('12万'), '120K');
    assert.equal(tr('25亿'), '2.5B');
  });
});

test('untranslated text stays readable instead of disappearing', () => {
  withCatalog({}, () => assert.equal(tr('没有翻译的句子'), '没有翻译的句子'));
});

test('catalog entries contain no Chinese and keep their placeholders', { skip: !existsSync(new URL('../data/i18n_en.json', import.meta.url)) }, () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/i18n_en.json', import.meta.url), 'utf8'));
  const holders = (s) => (s.match(/\{\w+\}/g) || []).slice().sort().join();
  for (const [zh, en] of Object.entries(catalog)) {
    assert.ok(!/[一-鿿]/.test(en), `Chinese left in: ${en}`);
    assert.equal(holders(zh), holders(en), zh);
  }
});

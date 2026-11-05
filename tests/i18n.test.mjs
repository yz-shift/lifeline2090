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

test('a one-character template only accepts captures it can fully translate', () => {
  withCatalog({ '{0} 个': '{0} items', 猫: 'cat' }, () => {
    assert.equal(tr('12 个'), '12 items');
    assert.equal(tr('猫 个'), 'cat items');
    assert.match(tr('没见过的动物 个'), /没见过的动物/);
  });
});

test('a/an and pronoun case follow what was filled in', () => {
  withCatalog({ '成了{0}。': 'You became a {0}.', 会计: 'accountant', 司机: 'driver', '记得{0}。': 'You remembered {0}.', 他: 'he' }, () => {
    assert.equal(tr('成了会计。'), 'You became an accountant.');
    assert.equal(tr('成了司机。'), 'You became a driver.');
    assert.equal(tr('记得他。'), 'You remembered him.');
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
    assert.equal(tr('1.2万亿'), '1.2T');
  });
});

test('news lines use the first sentence of a translated summary', () => {
  withCatalog({ 大事件: 'A big event', '第一句话很重要；第二句话不重要。': 'The first sentence matters; the second does not.', '【推演】': '[Projected]' }, () => {
    assert.equal(tr('大事件：第一句话很重要。'), 'A big event: The first sentence matters.');
    assert.equal(tr('【推演】大事件：第一句话很重要。'), '[Projected] A big event: The first sentence matters.');
  });
});

test('a template ending in a full stop works inside a longer text', () => {
  withCatalog({ '「{0}」的消息传开。': 'News of "{0}" spread.', 大事件: 'the big event', '你很担心。': 'You were worried.' }, () => {
    assert.equal(tr('「大事件」的消息传开。你很担心。'), 'News of "the big event" spread. You were worried.');
  });
});

test('adjacent placeholders split where both sides are known', () => {
  withCatalog({ '每周给{0}{1}': 'weekly {1} with {0}', 父母: 'your parents', 视频: 'video calls' }, () => {
    assert.equal(tr('每周给父母视频'), 'weekly video calls with your parents');
  });
});

test('generated names are read from their parts', () => {
  const names = { '@s:王': 'Wang', '@g:浩然': 'Haoran', '@s:欧阳': 'Ouyang', 阿尔琼: 'Arjun', 辛格: 'Singh', 约翰: 'John', 史密斯: 'Smith', '{0}来了': '{0} came' };
  withCatalog(names, () => {
    assert.equal(tr('王浩然'), 'Wang Haoran');
    assert.equal(tr('欧阳浩然'), 'Ouyang Haoran');
    assert.equal(tr('阿尔琼·辛格'), 'Arjun Singh');
    assert.equal(tr('约翰 史密斯'), 'John Smith');
    assert.equal(tr('王浩然来了'), 'Wang Haoran came');
  });
});

test('filled-in templates get singular nouns and a sentence capital', () => {
  withCatalog({ '有{0}个孩子': 'had {0} children', '活了{0}年': 'lived {0} years', '{0}走了。': '{0} left.', 你: 'you' }, () => {
    assert.equal(tr('有1个孩子'), 'had 1 child');
    assert.equal(tr('有2个孩子'), 'had 2 children');
    assert.equal(tr('活了1年'), 'lived 1 year');
    assert.equal(tr('活了2.1年'), 'lived 2.1 years');
    assert.equal(tr('活了11年'), 'lived 11 years');
    assert.equal(tr('你走了。'), 'You left.');
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

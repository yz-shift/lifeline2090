// Free-text choices read against the decision on screen (decisions.interpretCustom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpretCustom, interpretLine, INTENT_LABELS, INTENT_IDS } from '../src/core/decisions.js';
import { makeDataStore } from '../src/core/data.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });

// replies that only make sense against the decision on screen
const D = (key, opts) => ({ id: key, options: opts.map(([label, act], i) => ({ id: 'abcd'[i], label, detail: '', risk: 'mid' })),
  context: { key, acts: Object.fromEntries(opts.map(([, act], i) => ['abcd'[i], { act, p: {} }])), labels: Object.fromEntries(opts.map(([l], i) => ['abcd'[i], l])) } });
const offer = D('offer', [['接受外地的工作', 'accept_offer'], ['留在本地', 'stay_course'], ['先谈谈条件', 'promotion_push']]);
const grad = D('grad', [['考公务员', 'civil_service'], ['去大城市找工作', 'migrate_city'], ['回家乡工作', 'return_home'], ['继续读研', 'grad_school']]);
const marry = D('marry', [['听父母的去相亲', 'seek_partner'], ['再等等合适的人', 'stay_course'], ['一个人也挺好', 'stay_single']]);
const CTX = [
  [offer, '好', 'a'], [offer, '我去', 'a'], [offer, '答应他们', 'a'], [offer, '算了', 'b'], [offer, '不去了', 'b'], [offer, '选第三个', 'c'], [offer, 'C', 'c'],
  [offer, '先跟他们谈谈工资', 'c'], [offer, '还是留在本地吧', 'b'],
  [grad, '我去考编', 'a'], [grad, '考研', 'd'], [grad, '回老家上班', 'c'], [grad, '去北京找工作', 'b'], [grad, '第二个', 'b'], [grad, '读研究生', 'd'],
  [marry, '听爸妈的', 'a'], [marry, '再等等吧', 'b'], [marry, '不急，等缘分', 'b'], [marry, '我一个人过挺好', 'c'], [marry, '去相亲看看', 'a'],
];

test('short and contextual replies pick the matching option', () => {
  for (const [d, t, want] of CTX) {
    const it = interpretCustom(t, d, data, 'CHN');
    assert.equal(it.kind === 'option' && it.optionId, want, `${d.id}: ${t} -> ${JSON.stringify(it)}`);
  }
});

test('without options a reply is read by intent, and the UI line says how', () => {
  const it = interpretCustom('辞职去大理开民宿', null, data, 'CHN');
  assert.equal(it.kind, 'intent');
  assert.ok(it.intents.includes('start_business') && it.intents.includes('quit_job'));
  assert.match(interpretLine(it), /创业开店/);
  assert.equal(interpretCustom('去美国读博', null, data, 'CHN').labels[0], '出国读书');
  assert.equal(interpretCustom('嗯……', null, data).kind, 'noise');
  assert.equal(interpretCustom('好', null, data).kind, 'noise');
  assert.equal(interpretCustom('变成一只鸟', null, data).kind, 'fantasy');
  assert.equal(interpretCustom('我一个人过挺好', marry, data).optionId, 'c');
  for (const id of INTENT_IDS) assert.ok(INTENT_LABELS[id], id);
});

test('concrete money plans: market and style from the words', async () => {
  const { investPlanOf, aiKindOf } = await import('../src/core/decisions.js');
  assert.deepEqual([investPlanOf('定投美股').market, investPlanOf('定投美股').style], ['us_stocks', 'dca']);
  assert.equal(investPlanOf('每个月定投标普500').market, 'us_stocks');
  assert.equal(investPlanOf('把积蓄全部梭哈A股').style, 'all_in');
  assert.equal(investPlanOf('把积蓄全部梭哈A股').market, 'cn_stocks');
  assert.equal(investPlanOf('天天盯盘炒短线').style, 'trader');
  assert.equal(investPlanOf('每月买点黄金').style, 'gold');
  assert.equal(aiKindOf('用ChatGPT帮人写文案接单').kind, 'copy');
  assert.equal(aiKindOf('用AI画图卖头像').kind, 'art');
  assert.equal(aiKindOf('自己开发一个AI小程序收费').kind, 'app');
  assert.equal(aiKindOf('利用AI赚钱').kind, 'mixed');
  for (const t of ['利用AI赚钱', '学AI，接外包项目', '用AI做自媒体接广告']) assert.equal(interpretCustom(t, null, data, 'CHN').intents[0], 'ai_money', t);
  assert.equal(interpretCustom('学AI', null, data, 'CHN').intents[0], 'learn_ai');
  assert.equal(interpretCustom('定投美股', null, data, 'CHN').intents[0], 'invest_stocks');
});

test('the chosen market and a side income reach the yearly finances', async () => {
  const { assetReturn, sideIncomeOf } = await import('../src/core/economy.js');
  const { createWorld } = await import('../src/core/world.js');
  const world = createWorld(data, 5);
  // 2008: S&P 500 -37% vs the Chinese market's own year
  const us = assetReturn(world, 'stocks', 2008, null, { data, iso3: 'CHN', market: 'us_stocks' });
  const cn = assetReturn(world, 'stocks', 2008, null, { data, iso3: 'CHN' });
  assert.ok(us < -0.3 && Math.abs(us - cn) > 0.05, `${us} ${cn}`);
  assert.equal(assetReturn(world, 'stocks', 2008, null, { data, iso3: 'CHN', market: 'nope' }), cn);
  assert.equal(sideIncomeOf({ sideIncome: 0.5, sideIncomeUntil: 2030 }, 2029, 10000), 5000);
  assert.equal(sideIncomeOf({ sideIncome: 0.5, sideIncomeUntil: 2030 }, 2031, 10000), 0);
  assert.equal(sideIncomeOf({}, 2029, 10000), 0);
});

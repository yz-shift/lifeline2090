// 家人与生活 panel (opened in the life's side sheet with app.openPanel('family')): the people around this life as a
// family register, grouped (parents and elders, partner, children, grandchildren, siblings, others), with ages,
// alive or not, what they are doing and how close they are; pets, friends, habits and health conditions. Quick
// actions where the engine supports them: naming a newborn child (engine.nameChild) and the two family habits
// (孝亲费, 聚餐·送礼 via engine.setHabit). Reads engine.familyView (CONTRACT §10); without it a plain view is built
// from the LifeState so the panel always works.

import { h, clear, append } from '../dom.js';
import { RELATIONSHIP_LABELS } from '../../core/constants.js';
import * as engineMod from '../../core/engine.js';
import { habitControls, applyHabit } from './money.js';

export const meta = { tab: '家人与生活', title: '家人与生活', eyebrow: '附页 · 家庭登记' };

export const GROUPS = [
  { id: 'parents', title: '父母与长辈' },
  { id: 'partner', title: '伴侣' },
  { id: 'children', title: '子女' },
  { id: 'grandchildren', title: '孙辈' },
  { id: 'siblings', title: '兄弟姐妹' },
  { id: 'others', title: '其他亲友' },
];

const ROLE_GROUP = {
  mother: 'parents', father: 'parents', parent: 'parents', stepmother: 'parents', stepfather: 'parents',
  grandmother: 'parents', grandfather: 'parents', grandparent: 'parents', grandma: 'parents', grandpa: 'parents',
  partner: 'partner', spouse: 'partner', husband: 'partner', wife: 'partner', boyfriend: 'partner', girlfriend: 'partner',
  child: 'children', son: 'children', daughter: 'children', stepchild: 'children',
  grandchild: 'grandchildren', grandson: 'grandchildren', granddaughter: 'grandchildren',
  sibling: 'siblings', brother: 'siblings', sister: 'siblings',
};
const ROLE_LABEL = {
  mother: '母亲', father: '父亲', parent: '家长', stepmother: '继母', stepfather: '继父',
  grandmother: '祖母', grandfather: '祖父', grandparent: '祖辈', grandma: '祖母', grandpa: '祖父',
  grandchild: '孙辈', grandson: '孙子', granddaughter: '孙女', stepchild: '继子女', friend: '朋友', ex: '前任', exPartner: '前任',
};
const CLOSENESS = {
  close: { label: '亲近', cls: 'is-close', mark: '●' },
  ok: { label: '还好', cls: 'is-ok', mark: '◐' },
  distant: { label: '疏远', cls: 'is-distant', mark: '○' },
};
const PET_KIND = { dog: '狗', cat: '猫', bird: '鸟', fish: '鱼', rabbit: '兔子', hamster: '仓鼠', turtle: '乌龟', parrot: '鹦鹉' };
const SEVERITY = { 1: '轻度', 2: '中度', 3: '较重' };
const HABIT_NAMES = { dining: '聚餐·送礼', parents: '孝亲费', travel: '旅行', learning: '学习投入', health: '健康投入', charity: '捐助' };
const LEVEL_WORDS = ['', '一些', '很多'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const hasCJK = (s) => /[㐀-鿿]/.test(s);

/** A view built from the LifeState alone, for when engine.familyView is not available. Same shape as the engine's. */
export function fallbackFamilyView(state) {
  const p = (state && state.person) || {};
  const year = isNum(state && state.year) ? state.year : null;
  const members = [];
  const par = p.parents && typeof p.parents === 'object' ? p.parents : {};
  for (const role of ['mother', 'father']) {
    const x = par[role];
    if (!x || typeof x !== 'object') continue;
    members.push({ role, name: str(x.name) || ROLE_LABEL[role], sex: role === 'mother' ? 'female' : 'male', age: isNum(x.age) ? x.age : null, alive: x.alive !== false, status: '', closeness: null, note: '' });
  }
  const rel = p.relationship || {};
  if (rel.partner && typeof rel.partner === 'object' && ['married', 'partnered', 'dating'].includes(rel.status)) {
    const since = isNum(rel.partner.sinceYear) ? `${rel.partner.sinceYear} 年起在一起` : '';
    members.push({ role: 'partner', name: str(rel.partner.name) || '伴侣', sex: rel.partner.sex || null, age: isNum(rel.partner.age) ? rel.partner.age : null, alive: true, status: RELATIONSHIP_LABELS[rel.status] || '', closeness: null, note: since });
  }
  for (const c of Array.isArray(p.children) ? p.children : []) {
    if (!c || typeof c !== 'object') continue;
    members.push({ role: 'child', name: str(c.name) || '还没有名字', sex: c.sex, age: isNum(c.birthYear) && year != null ? Math.max(0, year - c.birthYear) : null, alive: c.alive !== false, status: '', closeness: null, note: c.adopted ? '收养' : '' });
  }
  const sib = isNum(p.siblings) ? p.siblings : 0;
  for (let i = 0; i < Math.min(sib, 8); i++) members.push({ role: 'sibling', name: '', sex: null, age: null, alive: true, status: '', closeness: null, note: '' });
  const habits = state && state.habits && typeof state.habits === 'object'
    ? Object.entries(state.habits).filter(([k, v]) => HABIT_NAMES[k] && v > 0).map(([k, v]) => ({ key: k, label: HABIT_NAMES[k], level: v }))
    : [];
  return { members, friends: null, pets: [], habits, conditions: Array.isArray(p.conditions) ? p.conditions : [] };
}

/** familyView from the engine when it exists (validated), else the fallback. */
export function familyViewOf(E, data, world, state) {
  if (E && typeof E.familyView === 'function') {
    try {
      const v = E.familyView(data, world, state);
      if (v && typeof v === 'object' && Array.isArray(v.members)) return { source: 'engine', ...v };
    } catch (e) { console.error(e); }
  }
  return { source: 'state', ...fallbackFamilyView(state) };
}

function groupOf(m) {
  const r = str(m.role);
  if (ROLE_GROUP[r]) return ROLE_GROUP[r];
  if (/母|父|爷|奶|外公|外婆|祖/.test(r)) return 'parents';
  if (/妻|夫|伴侣|恋人/.test(r)) return 'partner';
  if (/儿|女/.test(r) && !/孙/.test(r)) return 'children';
  if (/孙/.test(r)) return 'grandchildren';
  if (/兄|弟|姐|妹/.test(r)) return 'siblings';
  return 'others';
}

/** Chinese label for a member's role in this family. */
export function roleLabel(m, state) {
  if (str(m.label)) return str(m.label);
  const r = str(m.role);
  if (hasCJK(r)) return r;
  const g = groupOf(m);
  if (g === 'partner') {
    const st = state?.person?.relationship?.status;
    if (st === 'married' || r === 'spouse' || r === 'husband' || r === 'wife') return m.sex === 'female' || r === 'wife' ? '妻子' : m.sex === 'male' || r === 'husband' ? '丈夫' : '配偶';
    if (st === 'dating' || r === 'boyfriend' || r === 'girlfriend') return '恋人';
    return '伴侣';
  }
  if (g === 'children' && !ROLE_LABEL[r]) return m.sex === 'female' || r === 'daughter' ? '女儿' : m.sex === 'male' || r === 'son' ? '儿子' : '孩子';
  if (g === 'siblings') {
    if (typeof m.older === 'boolean') {
      if (m.sex === 'female') return m.older ? '姐姐' : '妹妹';
      if (m.sex === 'male') return m.older ? '哥哥' : '弟弟';
    }
    return r === 'sister' || m.sex === 'female' ? '姐妹' : r === 'brother' || m.sex === 'male' ? '兄弟' : '兄弟姐妹';
  }
  return ROLE_LABEL[r] || '亲友';
}

/** Members grouped in GROUPS order: [{id, title, members}] (empty groups dropped). */
export function groupMembers(view) {
  const map = new Map(GROUPS.map((g) => [g.id, []]));
  for (const m of Array.isArray(view && view.members) ? view.members : []) {
    if (!m || typeof m !== 'object') continue;
    map.get(groupOf(m)).push(m);
  }
  return GROUPS.map((g) => ({ ...g, members: map.get(g.id) })).filter((g) => g.members.length);
}

function petKind(k) {
  const s = str(k);
  return PET_KIND[s.toLowerCase()] || (hasCJK(s) ? s : '宠物');
}

function conditionText(c) {
  if (typeof c === 'string') return { name: c, sub: '' };
  if (!c || typeof c !== 'object') return null;
  const name = str(c.name) || str(c.label) || str(c.id);
  if (!name) return null;
  const sub = [SEVERITY[c.severity] || '', isNum(c.sinceYear) ? `${c.sinceYear} 年起` : ''].filter(Boolean).join(' · ');
  return { name, sub };
}

function habitText(x) {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object') return '';
  const label = str(x.label) || str(x.name) || HABIT_NAMES[x.key] || str(x.key);
  const lv = str(x.levelLabel) || (isNum(x.level) ? LEVEL_WORDS[x.level] || '' : '');
  return label ? `${label}${lv ? ` · ${lv}` : ''}` : '';
}

// ---------------------------------------------------------------------------------------------------------------

/** mount(root, params, app). params: {state, world, changed(kind), switchTo(name), deps?: {engine}}. */
export function mount(root, params = {}, app = {}) {
  const state = params.state;
  const data = app.data || params.data || {};
  const world = params.world || null;
  const E = (params.deps && params.deps.engine) || engineMod;
  const changed = typeof params.changed === 'function' ? params.changed : () => {};
  if (!state || !state.person) {
    root.append(h('div.ll-pn-empty', h('p', '还没有进行中的人生。'), h('p.ll-hint', '开始一段人生后，这里会记下家人、朋友和生活习惯。')));
    return undefined;
  }
  const dead = !!state.dead;
  const box = h('div.ll-fam');
  root.append(box);

  function render() {
    const view = familyViewOf(E, data, world, state);
    const groups = groupMembers(view);
    const p = state.person;
    const rel = RELATIONSHIP_LABELS[p.relationship?.status] || '';
    const kids = groups.find((g) => g.id === 'children')?.members.length || 0;
    const friends = isNum(view.friends) ? Math.max(0, Math.round(view.friends)) : null;
    const pets = Array.isArray(view.pets) ? view.pets.filter((x) => x && typeof x === 'object') : [];

    const grown = isNum(state.age) && state.age >= 16;
    const summary = h('ul.ll-fam-sum', { 'aria-label': '概况' },
      rel && (grown || p.relationship?.status !== 'single') ? h('li', rel) : null,
      kids || grown ? h('li', kids ? `${kids} 个孩子` : '没有孩子') : null,
      friends != null ? h('li', friends ? `${friends} 位常来往的朋友` : '眼下没有常来往的朋友') : null,
      pets.length ? h('li', `${pets.length} 只宠物`) : null);

    const sections = [];

    // -- naming a newborn (engine.nameChild) -------------------------------------------------------------------
    const np = state.namingPending;
    if (!dead && np && typeof np === 'object' && typeof E.nameChild === 'function') sections.push(namingSection(np));

    // -- the register --------------------------------------------------------------------------------------------
    if (groups.length) {
      for (const g of groups) {
        const sib = g.id === 'siblings' && g.members.every((m) => !str(m.name) && !isNum(m.age));
        sections.push(h('section.ll-pn-sec.ll-fam-group', { 'aria-labelledby': `ll-fam-g-${g.id}` },
          h('h3.ll-pn-h', { id: `ll-fam-g-${g.id}` }, g.title, h('span.ll-pn-h-sub', `${g.members.length} 人`)),
          sib
            ? h('p.ll-fam-plain', `有 ${g.members.length} 个兄弟姐妹。`)
            : h('ul.ll-fam-list', g.members.map((m) => memberRow(m)))));
      }
    } else {
      sections.push(h('p.ll-hint', '登记簿上暂时没有家人的记录。'));
    }

    // -- pets and friends ----------------------------------------------------------------------------------------
    if (pets.length || friends != null) {
      sections.push(h('section.ll-pn-sec', { 'aria-labelledby': 'll-fam-pf' },
        h('h3.ll-pn-h', { id: 'll-fam-pf' }, '宠物与朋友'),
        pets.length ? h('ul.ll-fam-list', pets.map((pet) => h('li.ll-fam-m.ll-fam-m--pet',
          h('span.ll-fam-av', { 'aria-hidden': 'true' }, petKind(pet.kind).slice(0, 1)),
          h('div.ll-fam-main',
            h('p.ll-fam-l1', h('span.ll-fam-name', str(pet.name) || '没取名字'), h('span.ll-fam-role', petKind(pet.kind)),
              isNum(pet.age) ? h('span.ll-fam-age', `${pet.age} 岁`) : null))))) : null,
        friends != null ? h('div.ll-fam-friends',
          h('span.ll-fam-dots', { 'aria-hidden': 'true' }, Array.from({ length: Math.min(friends, 12) }, () => h('i'))),
          h('span', friends ? `常来往的朋友约 ${friends} 位${friends > 12 ? '，朋友不少' : ''}` : '眼下没有常来往的朋友。多出去走走，会遇到合得来的人。')) : null));
    }

    // -- habits and health ---------------------------------------------------------------------------------------
    const habits = (Array.isArray(view.habits) ? view.habits : []).map(habitText).filter(Boolean);
    const conds = (Array.isArray(view.conditions) ? view.conditions : []).map(conditionText).filter(Boolean);
    sections.push(h('section.ll-pn-sec', { 'aria-labelledby': 'll-fam-hc' },
      h('h3.ll-pn-h', { id: 'll-fam-hc' }, '习惯与健康'),
      h('p.ll-fam-k', '生活习惯'),
      habits.length ? h('ul.ll-chips.ll-fam-chips', habits.map((t) => h('li.ll-chip', t))) : h('p.ll-hint', '没有特别的习惯。'),
      h('p.ll-fam-k', '身体状况'),
      conds.length
        ? h('ul.ll-chips.ll-fam-chips', conds.map((c) => h('li.ll-chip.ll-fam-cond', c.name, c.sub ? h('span.ll-fam-cond-sub', c.sub) : null)))
        : h('p.ll-hint', '没有登记在册的慢性病。')));

    // -- quick actions: the family habits (once the person handles money of their own) -------------------------
    if (!dead && grown) {
      const controls = habitControls({
        state, data, world, engine: E, idPrefix: 'll-fam-hb', readOnly: dead,
        onSet: (key, lv) => { applyHabit(E, state, key, lv); changed('habit'); },
      }, ['parents', 'dining']);
      sections.push(h('section.ll-pn-sec', { 'aria-labelledby': 'll-fam-act' },
        h('h3.ll-pn-h', { id: 'll-fam-act' }, '家里的安排', h('span.ll-pn-h-sub', '从今年起生效')),
        h('p.ll-hint', '多给父母一些照顾，或者多和朋友来往，都要花钱，也会慢慢改变关系的远近。'),
        controls,
        typeof params.switchTo === 'function'
          ? h('button.ll-btn.ll-btn--line.ll-btn--small.ll-fam-more', { type: 'button', onclick: () => params.switchTo('money') }, '其他花销和投资 →')
          : null));
    }

    append(clear(box), [summary, sections,
      h('p.ll-pn-foot', '家人、朋友和他们的经历都是按这个国家和年代的统计规律推演出来的，人物是虚构的。')]);
  }

  function memberRow(m) {
    const alive = m.alive !== false;
    const label = roleLabel(m, state);
    const name = str(m.name);
    const initial = (name && name !== label ? name : label).slice(0, 1) || '·';
    const ageText = !alive ? '已离世' : isNum(m.age) ? `${Math.max(0, Math.round(m.age))} 岁` : '';
    const c = alive && CLOSENESS[m.closeness];
    return h('li.ll-fam-m', { class: alive ? '' : 'is-gone' },
      h('span.ll-fam-av', { 'aria-hidden': 'true' }, initial),
      h('div.ll-fam-main',
        h('p.ll-fam-l1',
          h('span.ll-fam-name', name || label),
          name && name !== label ? h('span.ll-fam-role', label) : null,
          ageText ? h('span.ll-fam-age', ageText) : null),
        str(m.status) ? h('p.ll-fam-status', str(m.status)) : null,
        str(m.note) ? h('p.ll-fam-note', str(m.note)) : null),
      c ? h('span.ll-fam-close', { class: c.cls, title: `关系：${c.label}` }, h('span', { 'aria-hidden': 'true' }, c.mark), c.label) : null);
  }

  function namingSection(np) {
    const kids = Array.isArray(state.person.children) ? state.person.children : [];
    const child = kids[np.childIndex] || {};
    const sex = np.sex || child.sex;
    const who = sex === 'female' ? '女儿' : sex === 'male' ? '儿子' : '孩子';
    const sugg = (Array.isArray(np.suggestions) ? np.suggestions : []).map(str).filter(Boolean).slice(0, 5);
    const status = h('p.ll-fam-name-st', { role: 'status', 'aria-live': 'polite' });
    const input = h('input.ll-input.ll-fam-name-in', { type: 'text', maxlength: 12, autocomplete: 'off', placeholder: '自己起一个名字', 'aria-label': `给${who}起名字` });
    const give = (nm) => {
      const v = String(nm || '').replace(/\s+/g, ' ').trim().slice(0, 12);
      if (!v) { status.textContent = '先写下一个名字。'; input.focus(); return; }
      let ok = false;
      try { E.nameChild(state, np.childIndex, v); ok = true; } catch (e) { console.error(e); }
      if (!ok) { status.textContent = '这个名字没能登记，换一个试试。'; return; }
      changed('name');
      if (app && typeof app.toast === 'function') app.toast(`${who}的名字登记好了：${v}`, 'good');
      render();
    };
    return h('section.ll-pn-sec.ll-fam-naming', { 'aria-labelledby': 'll-fam-nm' },
      h('h3.ll-pn-h', { id: 'll-fam-nm' }, `给${who}取个名字`),
      h('p.ll-fam-plain', `${isNum(child.birthYear) ? `${child.birthYear} 年` : '今年'}，家里添了一个${who}。挑一个名字，或者自己起；到明年还没定，就用第一个。`),
      sugg.length ? h('div.ll-fam-names', { role: 'group', 'aria-label': '可以选的名字' },
        sugg.map((nm) => h('button.ll-btn.ll-btn--line.ll-btn--small', { type: 'button', onclick: () => give(nm) }, nm))) : null,
      h('form.ll-fam-name-form', { onsubmit: (e) => { e.preventDefault(); give(input.value); } },
        input, h('button.ll-btn.ll-btn--ink.ll-btn--small', { type: 'submit' }, '就叫这个')),
      status);
  }

  render();
  return undefined;
}

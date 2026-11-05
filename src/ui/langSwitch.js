// Language buttons, used in the header and on the settings screen. Labels are always in their own language, so a
// player who cannot read the current one can still find theirs.

import { h } from './dom.js';
import { LANGS, getLang, setLang, onLangChange } from '../i18n/index.js';

export function langSwitch({ wide = false } = {}) {
  const buttons = LANGS.map((l) => h('button.ll-lang-btn', {
    type: 'button',
    lang: l.id === 'en' ? 'en' : 'zh-CN',
    dataset: { id: l.id },
    onclick: () => pick(l.id),
  }, l.label));
  const root = h('div.ll-lang' + (wide ? '.ll-lang--wide' : ''), { role: 'group', 'aria-label': 'Language / 语言', 'data-no-i18n': '' }, buttons);

  function paint() {
    for (const b of buttons) {
      const on = b.dataset.id === getLang();
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  async function pick(id) {
    if (id === getLang()) return;
    root.classList.add('is-busy');
    try {
      await setLang(id);
    } catch (e) {
      console.error('could not switch language', e);
    }
    root.classList.remove('is-busy');
  }
  onLangChange(paint);
  paint();
  return root;
}

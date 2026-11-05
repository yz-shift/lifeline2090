// Keeps the page in the current language without touching each screen: a MutationObserver translates text nodes and
// labelled attributes as they appear. Observer callbacks run before paint, so Chinese never flashes on screen.
// The original text is remembered per node, so switching language back and forth works in place.

import { tr, getLang, onLangChange } from './index.js';

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CANVAS']);
const CJK = /[一-鿿]/;

const textState = new WeakMap(); // Text -> { orig, shown }
const attrState = new WeakMap(); // Element -> { name: { orig, shown } }

const skipped = (el) => !el || SKIP_TAGS.has(el.tagName) || el.isContentEditable || !!el.closest?.('[data-no-i18n]');

function renderText(node) {
  if (skipped(node.parentElement)) return;
  const current = node.nodeValue;
  const st = textState.get(node);
  const orig = st && st.shown === current ? st.orig : current;
  if (!st && !CJK.test(orig)) return;
  const shown = tr(orig);
  textState.set(node, { orig, shown });
  if (shown !== current) node.nodeValue = shown;
}

function renderAttrs(el) {
  if (el.closest?.('[data-no-i18n]')) return;
  for (const name of ATTRS) {
    const current = el.getAttribute?.(name);
    if (current == null) continue;
    let states = attrState.get(el);
    const st = states && states[name];
    const orig = st && st.shown === current ? st.orig : current;
    if (!st && !CJK.test(orig)) continue;
    const shown = tr(orig);
    if (!states) attrState.set(el, states = {});
    states[name] = { orig, shown };
    if (shown !== current) el.setAttribute(name, shown);
  }
}

function renderTree(rootNode) {
  if (rootNode.nodeType === Node.TEXT_NODE) { renderText(rootNode); return; }
  if (rootNode.nodeType !== Node.ELEMENT_NODE) return;
  renderAttrs(rootNode);
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) renderText(n);
    else renderAttrs(n);
  }
}

function applyDocumentLanguage() {
  document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN';
  document.documentElement.dataset.lang = getLang();
  if (!textState.has(document)) textState.set(document, document.title);
  document.title = tr(textState.get(document));
}

/** Start translating the document. Returns nothing: the observer lives as long as the page. */
export function installDomTranslator() {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(renderTree);
      else if (r.type === 'characterData') renderText(r.target);
      else renderAttrs(r.target);
    }
    observer.takeRecords(); // our own writes above do not need another pass
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const refresh = () => { applyDocumentLanguage(); renderTree(document.body); observer.takeRecords(); };
  onLangChange(refresh);
  refresh();
  return refresh;
}

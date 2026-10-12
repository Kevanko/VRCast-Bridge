// Язык интерфейса. Русский — исходный текст программы; английский накладывается
// словарём (i18n/en.js) прямо на страницу: на текст, подсказки и плейсхолдеры,
// в том числе на всё, что программа дорисовывает потом. «Авто» — по языку
// системы: WebView2 и браузер телефона берут его из Windows и Android.
// Названия роликов, списков и журнал помечены translate="no" и не трогаются.
(function () {
  const RU_LIKE = /^(ru|uk|be|kk)\b/i;
  const KEY = 'ui-lang';
  let choice = 'auto';
  try { choice = localStorage.getItem(KEY) || 'auto'; } catch {}
  const resolve = value => value === 'ru' || value === 'en' ? value : (RU_LIKE.test(navigator.language || '') ? 'ru' : 'en');
  let lang = resolve(choice);

  const dict = window.VRCAST_EN || { exact: {}, patterns: [] };
  const exact = new Map(Object.entries(dict.exact));
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = dict.patterns.map(([ru, en]) => [new RegExp('^' + ru.split('{}').map(escape).join('(.*?)') + '$', 's'), en]);
  const CYR = /[А-Яа-яЁё]/;

  // Одна строка: точное совпадение, затем шаблон (подстановки тоже переводятся),
  // затем по частям через « · » и «число + слово» («23 ролика»).
  function tr(text, depth = 0) {
    if (!CYR.test(text)) return text;
    const core = text.trim();
    const hit = exact.get(core);
    if (hit !== undefined) return text.replace(core, hit);
    if (depth > 2) return text;
    // Многострочные подсказки и хвосты «… ·» перед вложенным элементом — по частям.
    if (core.includes('\n')) return text.replace(core, core.split('\n').map(line => tr(line, depth + 1)).join('\n'));
    const хвост = /^(.*?)(\s*[·—:]\s*)$/s.exec(core);
    if (хвост && хвост[1] && хвост[2].trim()) return text.replace(core, tr(хвост[1], depth + 1) + хвост[2]);
    for (const [re, en] of patterns) {
      const m = re.exec(core);
      if (!m) continue;
      let k = 1;
      return text.replace(core, en.replace(/\{\}/g, () => tr(m[k++] ?? '', depth + 1)));
    }
    if (core.includes(' · ')) return text.replace(core, core.split(' · ').map(part => tr(part, depth + 1)).join(' · '));
    const num = /^([≥≈~]?\s*[\d.,]+)\s+(.+)$/.exec(core);
    if (num && exact.has(num[2])) return text.replace(core, `${num[1]} ${exact.get(num[2])}`);
    return text;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const skip = el => !el || el.closest?.('[translate="no"],script,style,textarea');
  function translateNode(node) {
    if (lang !== 'en') return;
    if (node.nodeType === 3) {
      if (skip(node.parentElement)) return;
      const next = tr(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1 || skip(node)) return;
    for (const name of ATTRS) {
      const value = node.getAttribute(name);
      if (value && CYR.test(value)) { const next = tr(value); if (next !== value) node.setAttribute(name, next); }
    }
    for (const child of node.childNodes) translateNode(child);
  }

  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') translateNode(r.target);
      else for (const n of r.addedNodes) translateNode(n);
    }
  });
  function start() {
    document.documentElement.lang = lang;
    if (lang !== 'en') return;
    translateNode(document.head.querySelector('title') || document.head);
    if (document.title && CYR.test(document.title)) document.title = tr(document.title);
    translateNode(document.body);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  // Системные окна подтверждения тоже на нужном языке.
  const nativeConfirm = window.confirm.bind(window), nativeAlert = window.alert.bind(window);
  window.confirm = message => nativeConfirm(lang === 'en' ? tr(String(message)) : message);
  window.alert = message => nativeAlert(lang === 'en' ? tr(String(message)) : message);

  window.vrcastLang = {
    get current() { return lang; },
    get choice() { return choice; },
    t: text => (lang === 'en' ? tr(String(text)) : text),
    // Смена языка: перерисовать проще всего перезагрузкой — исходный текст русский.
    set(value) {
      choice = ['ru', 'en'].includes(value) ? value : 'auto';
      try { localStorage.setItem(KEY, choice); } catch {}
      if (resolve(choice) !== lang) location.reload();
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

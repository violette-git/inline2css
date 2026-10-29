'use strict';

const csstree = require('css-tree');

/**
 * Collect the set of class names used anywhere in the parsed HTML.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Set<string>}
 */
function collectUsedClasses($) {
  const used = new Set();
  $('[class]').each((_, el) => {
    const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
    for (const c of cls) used.add(c);
  });
  return used;
}

/**
 * Unescape a CSS identifier so it matches the raw value used in HTML class
 * attributes. Tailwind emits classes like `md:flex` as `.md\:flex` and
 * `p-[13px]` as `.p-\[13px\]`; the backslash escapes must be removed before
 * comparing against the HTML class pool. Handles both `\:` style escapes and
 * `\3A ` hex escapes.
 * @param {string} name
 * @returns {string}
 */
function unescapeCssIdent(name) {
  // Hex escape: backslash + 1-6 hex digits + optional single whitespace.
  let out = name.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  // Simple escape: backslash before any single character.
  out = out.replace(/\\(.)/g, '$1');
  return out;
}

/**
 * Extract the class names referenced by a single complex selector AST,
 * unescaped to match HTML class attribute values.
 * @returns {string[]}
 */
function classesInSelector(selectorAst) {
  const classes = [];
  csstree.walk(selectorAst, {
    visit: 'ClassSelector',
    enter(node) {
      classes.push(unescapeCssIdent(node.name));
    },
  });
  return classes;
}

/**
 * Decide whether a selector is "used" given the available class pool.
 * A selector is kept when every class it references is present in the HTML.
 * Selectors that reference NO classes (e.g. `body`, `*`, `a:hover`) are
 * controlled by keepElementSelectors.
 * @param {object} selectorAst
 * @param {Set<string>} usedClasses
 * @param {boolean} keepElementSelectors
 * @returns {boolean}
 */
function selectorIsUsed(selectorAst, usedClasses, keepElementSelectors) {
  const classes = classesInSelector(selectorAst);
  if (classes.length === 0) {
    // No class hook at all (element/universal/attribute selectors).
    return keepElementSelectors;
  }
  return classes.every((c) => usedClasses.has(c));
}

/**
 * Resolve (tree-shake) one or more stylesheets down to only the rules whose
 * selectors are used by the given HTML. Preserves @media blocks, pseudo-state
 * selectors, source order, and (optionally) @keyframes / @font-face / :root.
 *
 * @param {string} cssText              concatenated source CSS
 * @param {Set<string>} usedClasses     classes present in the HTML
 * @param {object} [opts]
 * @param {boolean} [opts.keepElementSelectors=true]  keep bare element rules (body, a:hover)
 * @param {boolean} [opts.keepAtRules=true]           keep @keyframes/@font-face/:root/@import
 * @param {boolean} [opts.minify=false]
 * @returns {{css: string, keptRules: number, droppedRules: number}}
 */
function resolveStylesheet(cssText, usedClasses, opts = {}) {
  const {
    keepElementSelectors = true,
    keepAtRules = true,
    minify = false,
  } = opts;

  const ast = csstree.parse(cssText);
  let kept = 0;
  let dropped = 0;

  // Walk and prune. We rebuild each Rule's selector list to only the used
  // selectors; if none remain, the whole rule is removed.
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node, item, list) {
      // node.prelude is a SelectorList (or Raw for some at-rules)
      if (!node.prelude || node.prelude.type !== 'SelectorList') return;

      const keptSelectors = new csstree.List();
      node.prelude.children.forEach((sel) => {
        if (selectorIsUsed(sel, usedClasses, keepElementSelectors)) {
          keptSelectors.appendData(sel);
        }
      });

      if (keptSelectors.isEmpty) {
        dropped += 1;
        if (list) list.remove(item);
      } else {
        kept += 1;
        node.prelude.children = keptSelectors;
      }
    },
  });

  // Optionally strip non-essential at-rules (keyframes/font-face) when the
  // caller does not want them. By default we keep them.
  if (!keepAtRules) {
    csstree.walk(ast, {
      visit: 'Atrule',
      enter(node, item, list) {
        const name = (node.name || '').toLowerCase();
        if (name === 'keyframes' || name === 'font-face' || name === 'import') {
          if (list) list.remove(item);
        }
      },
    });
  }

  // Remove now-empty @media (and other) blocks left with no children.
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node, item, list) {
      if (node.block && node.block.children && node.block.children.isEmpty) {
        if (list) list.remove(item);
      }
    },
  });

  const css = csstree.generate(ast);
  if (minify) {
    return { css, keptRules: kept, droppedRules: dropped };
  }
  // css-tree generates minified; prettify lightly for readability.
  const pretty = prettifyCss(css);
  return { css: pretty, keptRules: kept, droppedRules: dropped };
}

/**
 * Very small, dependency-free CSS pretty printer for readable output.
 * Not a full formatter; adequate for generated stylesheets.
 */
function prettifyCss(min) {
  let out = '';
  let indent = 0;
  const pad = () => '    '.repeat(indent);
  for (let i = 0; i < min.length; i++) {
    const ch = min[i];
    if (ch === '{') {
      out += ' {\n';
      indent += 1;
      out += pad();
    } else if (ch === '}') {
      indent = Math.max(0, indent - 1);
      out = out.replace(/\s+$/, '') + '\n' + pad() + '}\n' + pad();
    } else if (ch === ';') {
      out += ';\n' + pad();
    } else {
      out += ch;
    }
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
    .join('\n')
    .trim() + '\n';
}

module.exports = {
  collectUsedClasses,
  classesInSelector,
  selectorIsUsed,
  resolveStylesheet,
};

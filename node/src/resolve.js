'use strict';

const path = require('path');
const csstree = require('css-tree');
const { renderStylesheet } = require('./core');

/** Name of the cascade layer that holds resolved framework CSS. */
const FRAMEWORK_LAYER = 'inline2css-framework';

/**
 * Layer for extracted inline declarations marked !important. It is declared
 * BEFORE the framework layer: for important declarations the earlier layer
 * wins, which reproduces how an inline !important beat framework !important.
 */
const IMPORTANT_LAYER = 'inline2css-important';

/**
 * Classes (and class patterns) that Bootstrap's JavaScript adds at runtime.
 * They never appear in static HTML, so tree-shaking would drop their rules.
 */
const BOOTSTRAP_PRESET = [
  'show', 'showing', 'hiding', 'collapse', 'collapsing', 'collapse-horizontal',
  'fade', 'active', 'disabled', 'open', 'modal-open', 'modal-backdrop',
  'modal-static', 'offcanvas-backdrop', 'is-valid', 'is-invalid',
  'was-validated', 'tooltip', 'tooltip-inner', 'tooltip-arrow', 'popover',
  'popover-arrow', 'popover-header', 'popover-body', 'carousel-item-next',
  'carousel-item-prev', 'carousel-item-start', 'carousel-item-end',
  'dropdown-menu-end', 'toast', /^bs-tooltip-/, /^bs-popover-/,
];

const PRESETS = { bootstrap: BOOTSTRAP_PRESET };

/** <script src> values that indicate Bootstrap's JavaScript is loaded. */
const BOOTSTRAP_SCRIPT_RE = /bootstrap(\.bundle)?(\.min)?\.js/i;

/**
 * Collect the set of class names used anywhere in the parsed HTML.
 * @param {import('cheerio').CheerioAPI} $
 * @param {Set<string>} [into] optional set to add to (directory mode union)
 * @returns {Set<string>}
 */
function collectUsedClasses($, into) {
  const used = into || new Set();
  $('[class]').each((_, el) => {
    const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
    for (const c of cls) used.add(c);
  });
  return used;
}

/**
 * True when the page loads Bootstrap's JavaScript (a matching <script src>)
 * or uses any `data-bs-*` attribute.
 * @param {import('cheerio').CheerioAPI} $
 */
function detectBootstrap($) {
  let found = false;
  $('script[src]').each((_, el) => {
    if (BOOTSTRAP_SCRIPT_RE.test($(el).attr('src') || '')) found = true;
  });
  if (found) return true;
  $('*').each((_, el) => {
    if (found) return false;
    for (const name of Object.keys(el.attribs || {})) {
      if (name.toLowerCase().startsWith('data-bs-')) {
        found = true;
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/**
 * Turn a safelist entry into a string or RegExp. A string wrapped in slashes
 * (optionally followed by flags) becomes a RegExp: "/^tooltip/" or "/x/i".
 * @param {string|RegExp} entry
 * @returns {string|RegExp}
 */
function parseSafelistEntry(entry) {
  if (entry instanceof RegExp) return entry;
  const s = String(entry);
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(s);
  if (m) return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
  return s;
}

/**
 * Expand preset names into their safelist entries.
 * @param {string|string[]} presets
 * @returns {Array<string|RegExp>}
 */
function presetEntries(presets) {
  const out = [];
  for (const name of [].concat(presets || [])) {
    const p = PRESETS[String(name).toLowerCase()];
    if (!p) {
      throw new Error(
        `Unknown safelist preset: ${name} (available: ${Object.keys(PRESETS).join(', ')})`,
      );
    }
    out.push(...p);
  }
  return out;
}

/**
 * Build the "class pool" used for matching: the classes found in the HTML
 * plus safelisted names and patterns. Anything with a `has(name)` method can
 * be used as a pool, so a plain Set works too.
 * @param {Iterable<string>} used
 * @param {Array<string|RegExp>} [safelist]
 * @returns {{has(name: string): boolean, classes: Set<string>, patterns: RegExp[]}}
 */
function makeClassPool(used, safelist = []) {
  const classes = new Set(used);
  const patterns = [];
  for (const raw of safelist) {
    const e = parseSafelistEntry(raw);
    if (e instanceof RegExp) patterns.push(e);
    else if (e) classes.add(e);
  }
  return {
    classes,
    patterns,
    has(name) {
      if (classes.has(name)) return true;
      for (const re of patterns) {
        re.lastIndex = 0;
        if (re.test(name)) return true;
      }
      return false;
    },
  };
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
  return String(name).replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex, ch) =>
    hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : ch,
  );
}

/**
 * Extract every class name referenced anywhere in a selector AST (including
 * inside :not() and other functional pseudos), unescaped.
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

/** Functional pseudos that match when ANY selector in their argument matches. */
const ANY_OF_PSEUDOS = new Set(['is', 'where', 'matches', '-webkit-any', '-moz-any', 'has']);

/**
 * Could this complex selector match, given the pool? Top-level classes in
 * every compound are required; classes inside :not() are ignored; :is() and
 * friends need at least one satisfiable branch; other functional pseudos
 * (:nth-child(of S), :host(), ::slotted(), ::part()) are treated as
 * satisfiable (conservative).
 */
function selectorSatisfiable(selectorAst, pool) {
  if (!selectorAst || !selectorAst.children) return true;
  let ok = true;
  selectorAst.children.forEach((node) => {
    if (!ok) return;
    if (node.type === 'ClassSelector') {
      if (!pool.has(unescapeCssIdent(node.name))) ok = false;
    } else if (node.type === 'PseudoClassSelector' && node.children) {
      const name = String(node.name).toLowerCase();
      if (!ANY_OF_PSEUDOS.has(name)) return; // :not() and others: ignore
      const list = node.children.first;
      if (!list || list.type !== 'SelectorList') return; // Raw etc: conservative
      let any = false;
      list.children.forEach((sel) => {
        if (!any && selectorSatisfiable(sel, pool)) any = true;
      });
      if (!any) ok = false;
    }
  });
  return ok;
}

/**
 * Decide whether a selector is "used" given the available class pool.
 * Selectors that reference no classes at all (body, *, a:hover, [hidden])
 * are controlled by keepElementSelectors. Everything else is kept when it
 * could match (see selectorSatisfiable).
 * @param {object} selectorAst
 * @param {{has(name:string):boolean}} usedClasses  Set or class pool
 * @param {boolean} [keepElementSelectors=true]
 * @returns {boolean}
 */
function selectorIsUsed(selectorAst, usedClasses, keepElementSelectors = true) {
  if (classesInSelector(selectorAst).length === 0) return keepElementSelectors;
  return selectorSatisfiable(selectorAst, usedClasses);
}

/** True when the walker context is inside @keyframes (keyframe selectors). */
function inKeyframes(atrule) {
  return !!atrule && /keyframes$/i.test(atrule.name || '');
}

/** Tree-shake rules in place. Returns {kept, dropped}. */
function shakeAst(ast, pool, keepElementSelectors) {
  let kept = 0;
  let dropped = 0;
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node, item, list) {
      if (!node.prelude || node.prelude.type !== 'SelectorList') return;
      if (inKeyframes(this.atrule)) return;
      const keptSelectors = new csstree.List();
      node.prelude.children.forEach((sel) => {
        if (selectorIsUsed(sel, pool, keepElementSelectors)) keptSelectors.appendData(sel);
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
  return { kept, dropped };
}

/**
 * Remove at-rule blocks left empty by pruning (innermost first). An empty
 * named @layer block becomes a `@layer name;` statement so layer order is
 * preserved.
 */
function removeEmptyBlocks(ast) {
  csstree.walk(ast, {
    visit: 'Atrule',
    leave(node, item, list) {
      if (!node.block || !node.block.children || !node.block.children.isEmpty) return;
      if (String(node.name).toLowerCase() === 'layer' && node.prelude) {
        node.block = null;
        return;
      }
      if (/^(font-face|page|property|counter-style|font-feature-values|viewport)$/i.test(node.name)) {
        return; // descriptor blocks are not "rule containers"
      }
      if (list) list.remove(item);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Dead @keyframes / @font-face pruning                                */
/* ------------------------------------------------------------------ */

const ANIMATION_PROPS = /^(-webkit-|-moz-|-o-)?animation(-name)?$/i;
const FONT_PROPS = /^(font|font-family)$/i;

function stripQuotes(s) {
  return String(s).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
}

function normFamily(s) {
  return unescapeCssIdent(stripQuotes(s)).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Gather custom property values plus animation / font values from the AST and
 * from extra declarations (the extracted inline rules).
 */
function collectValueUsage(ast, extraDecls) {
  const customProps = new Map();
  const animation = [];
  const font = [];
  const add = (prop, value) => {
    if (prop.startsWith('--')) {
      if (!customProps.has(prop)) customProps.set(prop, []);
      customProps.get(prop).push(value);
    } else if (ANIMATION_PROPS.test(prop)) animation.push(value);
    else if (FONT_PROPS.test(prop)) font.push(value);
  };
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      if (this.atrule && /^font-face$/i.test(this.atrule.name)) return;
      add(node.property, csstree.generate(node.value));
    },
  });
  for (const d of extraDecls || []) add(d.prop, d.value);
  return { customProps, animation, font };
}

/** Append the values of every custom property referenced via var(). */
function expandVars(value, customProps, seen = new Set()) {
  let out = value;
  const re = /var\(\s*(--[^,\s)]+)/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    for (const v of customProps.get(name) || []) {
      out += ', ' + expandVars(v, customProps, seen);
    }
  }
  return out;
}

/**
 * Drop @keyframes whose name is never referenced by an animation value, and
 * @font-face whose family is never referenced by a font / font-family value.
 * var() references are followed through custom properties.
 * @returns {number} number of at-rules dropped
 */
function pruneDeadAtRules(ast, extraDecls) {
  const usage = collectValueUsage(ast, extraDecls);
  const animTokens = new Set();
  for (const v of usage.animation) {
    const text = expandVars(v, usage.customProps);
    const re = /"([^"]*)"|'([^']*)'|((?:[-_a-zA-Z0-9 -￿]|\\.)+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      animTokens.add(unescapeCssIdent(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]));
    }
  }
  // Each comma piece of a font / font-family value yields its quoted names
  // plus the unquoted remainder (the shorthand `16px/1.5"Brand Sans"` has no
  // space before the string once generated, so quotes are split out first).
  const families = [];
  for (const v of usage.font) {
    for (const piece of expandVars(v, usage.customProps).split(',')) {
      const rest = piece.replace(/"([^"]*)"|'([^']*)'/g, (_, dq, sq) => {
        families.push(normFamily(dq !== undefined ? dq : sq));
        return ' ';
      });
      families.push(normFamily(rest));
    }
  }
  const familyUsed = (name) =>
    families.some((p) => p === name || p.endsWith(' ' + name));

  let dropped = 0;
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node, item, list) {
      const name = String(node.name).toLowerCase();
      if (/keyframes$/.test(name) && node.prelude) {
        const kf = unescapeCssIdent(stripQuotes(csstree.generate(node.prelude)));
        if (!animTokens.has(kf)) {
          dropped += 1;
          if (list) list.remove(item);
        }
      } else if (name === 'font-face' && node.block) {
        let family = null;
        node.block.children.forEach((d) => {
          if (d.type === 'Declaration' && /^font-family$/i.test(d.property)) {
            family = normFamily(csstree.generate(d.value));
          }
        });
        if (family && !familyUsed(family)) {
          dropped += 1;
          if (list) list.remove(item);
        }
      }
    },
  });
  return dropped;
}

/* ------------------------------------------------------------------ */
/* url() rewriting                                                     */
/* ------------------------------------------------------------------ */

const ABSOLUTE_URL_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#)/;

/**
 * Compute the rewritten form of one url() value, or null to leave it alone.
 * @param {string} url
 * @param {{from?: string, to?: string}} ctx  from: source file path or http(s) URL; to: output css path
 */
function rewriteUrlValue(url, ctx) {
  const u = String(url).trim();
  if (!u || /^data:/i.test(u)) return null;
  if (/^https?:\/\//i.test(ctx.from || '')) {
    if (ABSOLUTE_URL_RE.test(u)) return null;
    try {
      return new URL(u, ctx.from).href;
    } catch (_) {
      return null;
    }
  }
  if (!ctx.from || !ctx.to) return null;
  if (ABSOLUTE_URL_RE.test(u) || u.startsWith('/')) return null;
  const fromDir = path.dirname(path.resolve(ctx.from));
  const toDir = path.dirname(path.resolve(ctx.to));
  if (fromDir === toDir) return null;
  const cut = u.search(/[?#]/);
  const p = cut === -1 ? u : u.slice(0, cut);
  const suffix = cut === -1 ? '' : u.slice(cut);
  let rel = path.relative(toDir, path.resolve(fromDir, p)).split(path.sep).join('/');
  if (!rel) rel = '.';
  return rel + suffix;
}

/** Rewrite url() values (and @import "string" targets) in place. */
function rewriteUrls(ast, ctx) {
  if (!ctx || !ctx.from) return 0;
  let n = 0;
  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Url') {
        const r = rewriteUrlValue(node.value, ctx);
        if (r !== null) {
          node.value = r;
          n += 1;
        }
      } else if (node.type === 'Raw' && /url\(/i.test(node.value)) {
        // Unparsed values (custom properties, odd syntax) keep url() as text.
        node.value = node.value.replace(
          /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi,
          (whole, dq, sq, bare) => {
            const v = dq !== undefined ? dq : sq !== undefined ? sq : bare;
            const r = rewriteUrlValue(v, ctx);
            if (r === null) return whole;
            n += 1;
            return csstree.generate({ type: 'Url', value: r });
          },
        );
      } else if (node.type === 'Atrule' && /^import$/i.test(node.name) && node.prelude && node.prelude.children) {
        const first = node.prelude.children.first;
        if (first && first.type === 'String') {
          const r = rewriteUrlValue(first.value, ctx);
          if (r !== null) {
            first.value = r;
            n += 1;
          }
        }
      }
    },
  });
  return n;
}

/* ------------------------------------------------------------------ */
/* @charset / @import / @namespace hoisting and layering               */
/* ------------------------------------------------------------------ */

/**
 * Remove top-level @charset, @import and @namespace from the sheet. @import
 * and @namespace are returned as strings for hoisting; @import gets
 * `layer(<layer>)` only when a layer name is given (the opt-in --layer).
 */
function hoistTopLevel(ast, layer) {
  const imports = [];
  const namespaces = [];
  ast.children.forEach((node, item, list) => {
    if (node.type !== 'Atrule') return;
    const name = String(node.name).toLowerCase();
    if (name === 'charset') {
      list.remove(item);
    } else if (name === 'namespace') {
      namespaces.push(csstree.generate(node).replace(/;?$/, ';'));
      list.remove(item);
    } else if (name === 'import') {
      // Without a layer the @import is hoisted unchanged (same target form,
      // same layer / media parts).
      imports.push(importWithLayer(node, layer));
      list.remove(item);
    }
  });
  return { imports, namespaces };
}

function importWithLayer(node, layer) {
  const parts = [];
  let target = null;
  let targetNode = null;
  let existingLayer = null;
  let hasLayer = false;
  (node.prelude && node.prelude.children ? node.prelude.children.toArray() : []).forEach((c) => {
    if (!target && (c.type === 'Url' || c.type === 'String')) {
      target = c.value;
      targetNode = c;
    } else if (c.type === 'Identifier' && /^layer$/i.test(c.name)) {
      hasLayer = true;
    } else if (c.type === 'Function' && /^layer$/i.test(c.name)) {
      hasLayer = true;
      existingLayer = csstree.generate({ type: 'Value', children: c.children }).trim();
    } else {
      parts.push(csstree.generate(c));
    }
  });
  if (target === null) return csstree.generate(node).replace(/;?$/, ';');
  const url = layer ? csstree.generate({ type: 'Url', value: target }) : csstree.generate(targetNode);
  let layerPart = '';
  if (layer) layerPart = `layer(${existingLayer ? `${layer}.${existingLayer}` : layer})`;
  else if (existingLayer) layerPart = `layer(${existingLayer})`;
  else if (hasLayer) layerPart = 'layer';
  return `@import ${[url, layerPart, ...parts].filter(Boolean).join(' ')};`;
}

/* ------------------------------------------------------------------ */
/* Pretty printer                                                      */
/* ------------------------------------------------------------------ */

/**
 * Small, dependency-free CSS pretty printer. Never breaks lines inside
 * strings, comments, url(...)/other parentheses, or [attribute] brackets,
 * and copies backslash escapes verbatim.
 */
function prettifyCss(min) {
  let out = '';
  let indent = 0;
  let paren = 0;
  let bracket = 0;
  const pad = () => '    '.repeat(indent);
  const s = String(min);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      out += ch + (s[i + 1] !== undefined ? s[i + 1] : '');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\') j += 1;
        if (s[j] === '\n') break; // unterminated: stop at the line end
        j += 1;
      }
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      out += s.slice(i, j);
      i = j - 1;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    if (paren > 0 || bracket > 0) {
      out += ch;
      continue;
    }
    if (ch === '{') {
      out = out.replace(/[ \t]+$/, '') + ' {\n';
      indent += 1;
      out += pad();
    } else if (ch === '}') {
      indent = Math.max(0, indent - 1);
      out = out.replace(/[ \t\n]+$/, '') + '\n' + pad() + '}\n' + pad();
    } else if (ch === ';') {
      out += ';\n' + pad();
    } else {
      out += ch;
    }
  }
  return (
    out
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
      .join('\n')
      .trim() + '\n'
  );
}

/* ------------------------------------------------------------------ */
/* Full pipeline                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse one source sheet. css-tree re-serializes parsed values with minimal
 * whitespace (`0 0 #0000` becomes `0 0#0000`). That is harmless for normal
 * properties but not for `@property { initial-value: ... }`: a registered
 * custom property with `syntax: "*"` computes to its token stream as written,
 * so the original text of that descriptor is kept verbatim (as a Raw node).
 */
function parseSource(cssText) {
  const text = String(cssText);
  if (!/@property/i.test(text)) return csstree.parse(text);
  const ast = csstree.parse(text, { positions: true });
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      if (!this.atrule || !/^property$/i.test(this.atrule.name)) return;
      if (!/^initial-value$/i.test(node.property) || !node.value || !node.value.loc) return;
      const raw = text.slice(node.value.loc.start.offset, node.value.loc.end.offset).trim();
      node.value = { type: 'Raw', value: raw };
    },
  });
  return ast;
}

/**
 * Build the combined stylesheet from framework sources plus extracted inline
 * rules. Order: hoisted @import / @namespace, then the framework rules in
 * original source order (unlayered by default, wrapped in
 * @layer inline2css-framework only when opts.layer is set), then the
 * extracted inline rules.
 *
 * Framework CSS is NOT layered by default: a layered !important declaration
 * beats every unlayered !important one, so layering would flip !important
 * precedence against the page's own CSS. Extracted rules are boosted instead
 * (`.i2c-1:not(#\#)`), which beats class-only rules like an inline style did.
 *
 * @param {Array<{css:string, from?:string}>} sources
 * @param {{has(name:string):boolean}} pool
 * @param {object} [opts]
 * @param {string}  [opts.to]                     output css path (for url rewriting)
 * @param {Array<{className:string,decls:Array}>} [opts.inlineRules]  extracted rules, emitted last
 * @param {boolean} [opts.boost=true]             add :not(#\\#) to extracted selectors (false: plain .class)
 * @param {Array<{prop:string,value:string}>} [opts.inlineDecls]  extra usage for at-rule pruning
 * @param {boolean|string} [opts.layer=false]     true or a layer name to wrap the framework
 * @param {boolean} [opts.keepAllAtRules=false]
 * @param {boolean} [opts.keepElementSelectors=true]
 * @param {boolean} [opts.minify=false]
 */
function buildStylesheet(sources, pool, opts = {}) {
  const {
    to,
    inlineRules = [],
    keepAllAtRules = false,
    keepElementSelectors = true,
    minify = false,
  } = opts;
  const boost = opts.boost !== false;
  const layer = opts.layer === true ? FRAMEWORK_LAYER : opts.layer || null;
  const inlineDecls = [...(opts.inlineDecls || [])];
  for (const r of inlineRules) inlineDecls.push(...r.decls);

  const sheet = csstree.parse('');
  for (const src of sources) {
    if (!src || !String(src.css || '').trim()) continue;
    const ast = parseSource(src.css);
    rewriteUrls(ast, { from: src.from, to });
    sheet.children.appendList(ast.children);
  }

  const { kept, dropped } = shakeAst(sheet, pool, keepElementSelectors);
  const { imports, namespaces } = hoistTopLevel(sheet, layer);
  const droppedAtRules = keepAllAtRules ? 0 : pruneDeadAtRules(sheet, inlineDecls);
  removeEmptyBlocks(sheet);

  // Split extracted inline rules: when layering, !important declarations go
  // to a layer ordered before the framework layer (see IMPORTANT_LAYER).
  // Without a layer they stay in the same (boosted) rule: an important
  // (1,1,0) selector beats class-only important rules, like inline !important.
  const isImportant = (d) => /!\s*important\s*$/i.test(d.value);
  let normalRules = inlineRules;
  let importantRules = [];
  if (layer) {
    normalRules = [];
    for (const r of inlineRules) {
      const imp = r.decls.filter(isImportant);
      const norm = r.decls.filter((d) => !isImportant(d));
      if (norm.length) normalRules.push({ ...r, decls: norm });
      if (imp.length) importantRules.push({ ...r, decls: imp });
    }
  }
  const inlineCss = renderStylesheet(normalRules, minify, { boost });

  let body = sheet.children.isEmpty ? '' : csstree.generate(sheet);
  if (body && layer) body = `@layer ${layer}{${body}}`;
  let order = '';
  let importantCss = '';
  if (importantRules.length) {
    order = `@layer ${IMPORTANT_LAYER},${layer};`;
    importantCss = `@layer ${IMPORTANT_LAYER}{${renderStylesheet(importantRules, true, { boost })}}`;
    if (!minify) importantCss = prettifyCss(importantCss);
  }
  let fw = order + imports.join('') + namespaces.join('') + body;
  if (fw && !minify) fw = prettifyCss(fw);

  const pieces = [fw, inlineCss, importantCss].filter((s) => s && s.trim());
  const css = minify
    ? pieces.join('')
    : pieces.map((p) => p.replace(/\s+$/, '')).join('\n\n') + (pieces.length ? '\n' : '');
  return { css, keptRules: kept, droppedRules: dropped, droppedAtRules };
}

/**
 * Resolve (tree-shake) one or more stylesheets down to only the rules whose
 * selectors could match the given class pool. Synchronous; no I/O.
 *
 * @param {string|Array<{css:string, from?:string}>} cssText  CSS text or sources
 * @param {Set<string>|{has(name:string):boolean}} usedClasses
 * @param {object} [opts]
 * @param {boolean} [opts.keepElementSelectors=true]
 * @param {boolean} [opts.keepAllAtRules=false]  keep unreferenced @keyframes / @font-face
 * @param {boolean} [opts.keepAtRules]           deprecated alias: true means keepAllAtRules
 * @param {Array<string|RegExp>} [opts.safelist]
 * @param {string|string[]} [opts.safelistPreset]
 * @param {boolean|string} [opts.layer=false]    wrap output in @layer (true = inline2css-framework)
 * @param {string} [opts.from]  source path or URL (url rewriting, string input only)
 * @param {string} [opts.to]    output css path (url rewriting)
 * @param {Array<{prop:string,value:string}>} [opts.inlineDecls] extra declarations that count as usage
 * @param {boolean} [opts.minify=false]
 * @returns {{css: string, keptRules: number, droppedRules: number, droppedAtRules: number}}
 */
function resolveStylesheet(cssText, usedClasses, opts = {}) {
  const sources = Array.isArray(cssText) ? cssText : [{ css: String(cssText), from: opts.from }];
  const extra = [...(opts.safelist || []), ...presetEntries(opts.safelistPreset)];
  const pool =
    extra.length || !usedClasses || typeof usedClasses.has !== 'function'
      ? makeClassPool(
          usedClasses && usedClasses.classes ? usedClasses.classes : usedClasses || [],
          [...((usedClasses && usedClasses.patterns) || []), ...extra],
        )
      : usedClasses;
  return buildStylesheet(sources, pool, {
    to: opts.to,
    inlineDecls: opts.inlineDecls,
    layer: opts.layer || false,
    keepAllAtRules: opts.keepAllAtRules === true || opts.keepAtRules === true,
    keepElementSelectors: opts.keepElementSelectors !== false,
    minify: !!opts.minify,
  });
}

module.exports = {
  FRAMEWORK_LAYER,
  IMPORTANT_LAYER,
  BOOTSTRAP_PRESET,
  PRESETS,
  collectUsedClasses,
  detectBootstrap,
  parseSafelistEntry,
  presetEntries,
  makeClassPool,
  unescapeCssIdent,
  classesInSelector,
  selectorIsUsed,
  rewriteUrlValue,
  pruneDeadAtRules,
  prettifyCss,
  buildStylesheet,
  resolveStylesheet,
};

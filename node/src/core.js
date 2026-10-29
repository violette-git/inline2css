'use strict';

const crypto = require('crypto');
const { load } = require('cheerio');

/**
 * Parse a `style` attribute value into an ordered array of {prop, value}.
 * Tolerates missing trailing semicolons, extra whitespace, quoted values,
 * and semicolons inside url(...) or quotes. Last-wins on duplicate property.
 * @param {string} style
 * @returns {Array<{prop: string, value: string}>}
 */
function parseDeclarations(style) {
  const pieces = [];
  let buf = '';
  let depth = 0;
  let quote = null;

  for (const ch of String(style)) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      depth++;
      buf += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === ';' && depth === 0) {
      pieces.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) pieces.push(buf);

  const map = new Map();
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const prop = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (prop && value) map.set(prop, value); // last-wins
  }
  return Array.from(map, ([prop, value]) => ({ prop, value }));
}

/** Stable canonical key so identical styles collapse regardless of order. */
function canonical(decls) {
  return decls
    .map((d) => `${d.prop}:${d.value}`)
    .sort()
    .join(';');
}

/** Sanitize a CSS value fragment into a class-name-safe token. */
function slug(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Generate a class name for a set of declarations under the chosen naming
 * strategy: 'sequential' (i2c-1), 'hash' (i2c-a1b2c3), or 'semantic'.
 */
function makeClassName(decls, key, strategy, prefix, seq) {
  if (strategy === 'hash') {
    const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 6);
    return `${prefix}${h}`;
  }
  if (strategy === 'semantic') {
    const first = decls[0];
    const base = slug(`${first.prop}-${first.value}`);
    const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 4);
    return `${prefix}${base || 'style'}-${h}`;
  }
  return `${prefix}${seq}`;
}

/**
 * Suffix that adds one id of specificity without changing what matches:
 * `#\#` is an id selector no element has, so `:not(#\#)` always matches.
 */
const BOOST_SUFFIX = ':not(#\\#)';

/**
 * Render one CSS rule, optionally minified. With `boost`, the selector gets
 * BOOST_SUFFIX so it beats ordinary framework class selectors.
 */
function renderRule(className, decls, minify, boost = false) {
  const sel = `.${className}${boost ? BOOST_SUFFIX : ''}`;
  if (minify) {
    const body = decls.map((d) => `${d.prop}:${d.value}`).join(';');
    return `${sel}{${body}}`;
  }
  const body = decls.map((d) => `    ${d.prop}: ${d.value};`).join('\n');
  return `${sel} {\n${body}\n}`;
}

/**
 * Convert a single HTML string.
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.prefix='i2c-']
 * @param {'sequential'|'hash'|'semantic'} [opts.naming='sequential']
 * @param {string} [opts.cssHref='styles.css']  href used for the <link>
 * @param {boolean} [opts.minify=false]
 * @param {boolean} [opts.injectLink=true]
 * @param {Map<string,{className:string,decls:Array}>} [opts.registry]
 *        shared registry for directory mode (dedup across files)
 * @param {{n:number}} [opts.counter] shared sequential counter for dir mode
 * @returns {{html: string, rules: Array<{className:string, decls:Array, key:string}>}}
 */
function convert(html, opts = {}) {
  const {
    prefix = 'i2c-',
    naming = 'sequential',
    cssHref = 'styles.css',
    minify = false,
    injectLink = true,
    registry = new Map(),
    counter = { n: 0 },
  } = opts;

  const $ = load(html, { decodeEntities: false }, true);
  let touched = false;

  $('[style]').each((_, el) => {
    const $el = $(el);
    const decls = parseDeclarations($el.attr('style') || '');
    if (decls.length === 0) {
      $el.removeAttr('style');
      touched = true;
      return;
    }
    const key = canonical(decls);
    let entry = registry.get(key);
    if (!entry) {
      counter.n += 1;
      const className = makeClassName(decls, key, naming, prefix, counter.n);
      entry = { className, decls, key };
      registry.set(key, entry);
    }
    const existing = ($el.attr('class') || '').split(/\s+/).filter(Boolean);
    if (!existing.includes(entry.className)) existing.push(entry.className);
    $el.attr('class', existing.join(' '));
    $el.removeAttr('style');
    touched = true;
  });

  if (touched && injectLink) {
    let $head = $('head');
    if ($head.length === 0) {
      if ($('html').length) $('html').prepend('<head></head>');
      else $.root().prepend('<head></head>');
      $head = $('head');
    }
    const linkExists =
      $head.find(`link[href="${cssHref}"]`).length > 0;
    if (!linkExists) {
      $head.append(`<link rel="stylesheet" href="${cssHref}">`);
    }
  }

  const rules = Array.from(registry.values());
  return { html: $.html(), rules };
}

/**
 * Build a stylesheet string from collected rules.
 * @param {Array<{className:string, decls:Array}>} rules
 * @param {boolean} [minify=false]
 * @param {{boost?: boolean}} [opts]
 */
function renderStylesheet(rules, minify = false, opts = {}) {
  if (rules.length === 0) return '';
  const sep = minify ? '' : '\n\n';
  const boost = !!(opts && opts.boost);
  const css = rules.map((r) => renderRule(r.className, r.decls, minify, boost)).join(sep);
  return minify ? css : css + '\n';
}

module.exports = {
  BOOST_SUFFIX,
  parseDeclarations,
  canonical,
  makeClassName,
  convert,
  renderStylesheet,
};

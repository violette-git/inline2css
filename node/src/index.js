'use strict';

const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');
const {
  parseDeclarations,
  canonical,
  convert,
  renderStylesheet,
} = require('./core');
const {
  collectUsedClasses,
  resolveStylesheet,
  selectorIsUsed,
  detectBootstrap,
  presetEntries,
  makeClassPool,
  buildStylesheet,
  BOOTSTRAP_PRESET,
  FRAMEWORK_LAYER,
} = require('./resolve');

const isHttp = (s) => /^https?:\/\//i.test(String(s));

/**
 * Load CSS text from a source that may be a local file path or an http(s) URL.
 * @param {string} src
 * @param {string} [baseDir]  directory to resolve relative file paths against
 * @returns {Promise<string>}
 */
async function loadCssSource(src, baseDir = process.cwd()) {
  return (await loadCss(src, baseDir)).css;
}

/** Like loadCssSource but also returns where it came from (path or URL). */
async function loadCss(src, baseDir = process.cwd()) {
  if (isHttp(src)) {
    if (typeof fetch !== 'function') {
      throw new Error('Fetching URLs needs Node 18 or newer (global fetch)');
    }
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch ${src}: ${res.status}`);
    return { css: await res.text(), from: src };
  }
  const p = path.isAbsolute(src) ? src : path.join(baseDir, src);
  return { css: fs.readFileSync(p, 'utf8'), from: p };
}

/** Basename of an href or path, with any query string or fragment removed. */
function hrefBasename(href) {
  const clean = String(href).split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** Every <link rel=stylesheet> (rel may be a token list) in the page. */
function stylesheetLinks($) {
  const out = [];
  $('link[rel][href]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet')) out.push(el);
  });
  return out;
}

/**
 * Remove the <link rel=stylesheet> tags that were folded into the output,
 * then make sure one <link> to the new stylesheet exists.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} newHref
 * @param {{all?: boolean, basenames?: Set<string>}} which
 *   all: remove every stylesheet link (--resolve-linked); basenames: remove
 *   links whose href basename is in the set (explicit --resolve sources).
 */
function rewriteLinks($, newHref, which = {}) {
  const basenames = which.basenames || new Set();
  for (const el of stylesheetLinks($)) {
    const href = $(el).attr('href');
    if (href === newHref) continue;
    if (which.all || basenames.has(hrefBasename(href))) $(el).remove();
  }
  let $head = $('head');
  if ($head.length === 0) {
    if ($('html').length) $('html').prepend('<head></head>');
    else $.root().prepend('<head></head>');
    $head = $('head');
  }
  if ($head.find(`link[href="${newHref}"]`).length === 0) {
    $head.append(`<link rel="stylesheet" href="${newHref}">`);
  }
}

/** Default output path for a cleaned HTML file. */
function cleanedPath(file) {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}.cleaned${ext}`);
}

/** Recursively list .html/.htm files, skipping node_modules and dot-dirs. */
function listHtmlFiles(dir) {
  const files = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.html?$/i.test(entry.name) && !/\.cleaned\.html?$/i.test(entry.name)) {
        files.push(full);
      }
    }
  })(dir);
  return files.sort();
}

/** href from an HTML file to the CSS file, POSIX separators. */
function relHref(htmlFile, cssPath) {
  return path.relative(path.dirname(path.resolve(htmlFile)), path.resolve(cssPath)).split(path.sep).join('/');
}

/**
 * Parse an existing stylesheet's simple `.class { ... }` rules into a registry
 * so a follow-up run can reuse (merge into) existing classes instead of
 * emitting duplicates. Only single-class selectors are considered for reuse.
 * @param {string} css
 * @returns {Map<string,{className:string, decls:Array, key:string}>}
 */
function parseExistingCss(css) {
  const registry = new Map();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    // Also accept a boosted selector (.name:not(#\#)) written by --boost.
    const single = /^\.([A-Za-z_][-\w]*)(?::not\(#\\#\))?$/.exec(selector);
    if (!single) continue;
    const decls = parseDeclarations(body);
    if (decls.length === 0) continue;
    const key = canonical(decls);
    if (!registry.has(key)) {
      registry.set(key, { className: single[1], decls, key });
    }
  }
  return registry;
}

/**
 * Convert one HTML file on disk.
 * @param {string} inputPath
 * @param {object} [opts] see core.convert plus:
 *   @param {string} [opts.css]      output css path (default: dir/styles.css)
 *   @param {string} [opts.htmlOut]  output html path (default: <input>.cleaned.html)
 *   @param {boolean}[opts.inPlace]  overwrite input html
 *   @param {boolean}[opts.dryRun]   compute but do not write
 *   @param {boolean}[opts.merge]    merge into existing css if present
 * @returns {{cssPath:string, htmlPath:string, ruleCount:number, wrote:boolean}}
 */
function convertFile(inputPath, opts = {}) {
  const html = fs.readFileSync(inputPath, 'utf8');
  const dir = path.dirname(inputPath);
  const cssPath = opts.css || path.join(dir, 'styles.css');
  const cssHref = path.basename(cssPath);

  let registry = new Map();
  let counter = { n: 0 };
  if (opts.merge && fs.existsSync(cssPath)) {
    registry = parseExistingCss(fs.readFileSync(cssPath, 'utf8'));
    counter.n = registry.size;
  }

  const { html: newHtml, rules } = convert(html, {
    ...opts,
    cssHref,
    registry,
    counter,
  });

  const cssText = renderStylesheet(rules, opts.minify, opts);

  let htmlPath;
  if (opts.inPlace) htmlPath = inputPath;
  else if (opts.htmlOut) htmlPath = opts.htmlOut;
  else {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    htmlPath = path.join(dir, `${base}.cleaned${ext}`);
  }

  if (!opts.dryRun) {
    fs.writeFileSync(cssPath, cssText, 'utf8');
    fs.writeFileSync(htmlPath, newHtml, 'utf8');
  }

  return { cssPath, htmlPath, ruleCount: rules.length, wrote: !opts.dryRun };
}

/**
 * Convert every .html file in a directory (recursively) into ONE shared
 * stylesheet, deduplicating classes across all pages.
 * @param {string} dir
 * @param {object} [opts]
 * @returns {{cssPath:string, files:Array<{htmlPath:string}>, ruleCount:number, wrote:boolean}}
 */
function convertDirectory(dir, opts = {}) {
  const cssPath = opts.css || path.join(dir, 'styles.css');
  const cssHref = path.basename(cssPath);

  const registry = new Map();
  const counter = { n: 0 };

  if (opts.merge && fs.existsSync(cssPath)) {
    const existing = parseExistingCss(fs.readFileSync(cssPath, 'utf8'));
    for (const [k, v] of existing) registry.set(k, v);
    counter.n = registry.size;
  }

  const htmlFiles = listHtmlFiles(dir);

  const results = [];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.dirname(file), cssPath).split(path.sep).join('/');
    const { html: newHtml } = convert(html, {
      ...opts,
      cssHref: rel || cssHref,
      registry,
      counter,
    });
    const htmlPath = opts.inPlace ? file : cleanedPath(file);
    if (!opts.dryRun) fs.writeFileSync(htmlPath, newHtml, 'utf8');
    results.push({ htmlPath });
  }

  const cssText = renderStylesheet(Array.from(registry.values()), opts.minify, opts);
  if (!opts.dryRun) fs.writeFileSync(cssPath, cssText, 'utf8');

  return {
    cssPath,
    files: results,
    ruleCount: registry.size,
    wrote: !opts.dryRun,
  };
}

/**
 * Build the class pool for resolve mode: used classes plus --safelist entries,
 * --safelist-preset entries, and (unless disabled) the Bootstrap preset when
 * Bootstrap's JS or data-bs-* attributes are detected.
 * @returns {{pool: object, autoDetected: boolean}}
 */
function buildPool(used, pages$, opts) {
  const entries = [...(opts.safelist || []), ...presetEntries(opts.safelistPreset)];
  const presets = [].concat(opts.safelistPreset || []).map((p) => String(p).toLowerCase());
  let autoDetected = false;
  if (opts.autoSafelist !== false && !presets.includes('bootstrap')) {
    if (pages$.some(($) => detectBootstrap($))) {
      autoDetected = true;
      entries.push(...BOOTSTRAP_PRESET);
    }
  }
  return { pool: makeClassPool(used, entries), autoDetected };
}

/** Notes go to opts.log (a function), or stderr by default; false silences. */
function note(opts, msg) {
  if (opts.log === false) return;
  if (typeof opts.log === 'function') opts.log(msg);
  else process.stderr.write(`${msg}\n`);
}

const AUTO_NOTE =
  'note: Bootstrap JavaScript detected, keeping its runtime classes (--safelist-preset bootstrap). Use --no-auto-safelist to disable.';

/**
 * Shared resolve pipeline for one or more pages.
 * @param {string[]} files  HTML files
 * @param {object} opts
 * @param {string} cssPath
 * @param {(file:string)=>string} htmlOutFor
 */
async function resolvePages(files, opts, cssPath, htmlOutFor) {
  const registry = new Map();
  const counter = { n: 0 };
  const used = new Set();
  const pages = [];
  const explicit = opts.resolve || [];
  const explicitBasenames = new Set(explicit.map(hrefBasename));

  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const cssHref = relHref(file, cssPath) || path.basename(cssPath);
    // Inline extraction (links are managed below), shared registry across pages.
    const { html: afterInline } = convert(original, {
      prefix: opts.prefix || 'i2c-',
      naming: opts.naming || 'sequential',
      cssHref,
      injectLink: false,
      registry,
      counter,
    });
    const $ = load(afterInline, { decodeEntities: false }, true);
    collectUsedClasses($, used);
    pages.push({ file, $, cssHref });
  }

  // Sources: linked sheets (relative to each page) then explicit ones (cwd).
  const sources = [];
  const seen = new Set();
  if (opts.resolveLinked) {
    for (const page of pages) {
      for (const el of stylesheetLinks(page.$)) {
        const href = page.$(el).attr('href');
        if (!href || href === page.cssHref) continue;
        const url = href.startsWith('//') ? `https:${href}` : href; // protocol-relative CDN links
        const key = isHttp(url) ? url : path.resolve(path.dirname(page.file), url.split(/[?#]/)[0]);
        if (key === path.resolve(cssPath) || seen.has(key)) continue;
        seen.add(key);
        try {
          sources.push(await loadCss(key, process.cwd()));
        } catch (e) {
          note(opts, `warn: could not load linked sheet ${href}: ${e.message}`);
        }
      }
    }
  }
  for (const src of explicit) {
    const key = isHttp(src) ? src : path.resolve(src);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(await loadCss(src, process.cwd()));
  }

  const { pool, autoDetected } = buildPool(used, pages.map((p) => p.$), opts);
  if (autoDetected) note(opts, AUTO_NOTE);

  const inlineRules = Array.from(registry.values());
  const result = buildStylesheet(sources, pool, {
    to: cssPath,
    inlineRules,
    boost: !!opts.boost,
    layer: opts.layer === false ? false : opts.layer || true,
    keepAllAtRules: !!opts.keepAllAtRules,
    minify: !!opts.minify,
  });

  const outFiles = [];
  for (const page of pages) {
    rewriteLinks(page.$, page.cssHref, {
      all: !!opts.resolveLinked,
      basenames: explicitBasenames,
    });
    const htmlPath = htmlOutFor(page.file);
    if (!opts.dryRun) fs.writeFileSync(htmlPath, page.$.html(), 'utf8');
    outFiles.push({ htmlPath });
  }
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(path.resolve(cssPath)), { recursive: true });
    fs.writeFileSync(cssPath, result.css, 'utf8');
  }

  return {
    cssPath,
    files: outFiles,
    inlineRules: inlineRules.length,
    resolvedKept: result.keptRules,
    resolvedDropped: result.droppedRules,
    atRulesDropped: result.droppedAtRules,
    autoSafelist: autoDetected,
    wrote: !opts.dryRun,
  };
}

/**
 * Resolve mode: extract inline styles AND tree-shake framework stylesheets
 * down to the rules the HTML can use, emitting one combined stylesheet.
 * Framework classes stay in the HTML as hooks; inline styles and folded-in
 * <link> tags are removed.
 *
 * @param {string} inputPath
 * @param {object} opts
 *   @param {string[]} [opts.resolve]        stylesheet paths/URLs (relative to cwd)
 *   @param {boolean}  [opts.resolveLinked]  also resolve <link> sheets in the HTML
 *   @param {Array<string|RegExp>} [opts.safelist]  extra classes / patterns to keep
 *   @param {string|string[]} [opts.safelistPreset] e.g. 'bootstrap'
 *   @param {boolean}  [opts.autoSafelist=true]  auto-apply presets when detected
 *   @param {boolean}  [opts.layer=true]     wrap framework CSS in @layer inline2css-framework
 *   @param {boolean}  [opts.boost=false]    extracted selectors get :not(#\#)
 *   @param {boolean}  [opts.keepAllAtRules=false]  keep unreferenced @keyframes/@font-face
 *   @param {string}   [opts.css]            output css path
 *   @param {string}   [opts.htmlOut]
 *   @param {boolean}  [opts.inPlace]
 *   @param {boolean}  [opts.dryRun]
 *   @param {boolean}  [opts.minify]
 *   @param {string}   [opts.naming], [opts.prefix]  (for inline extraction)
 *   @param {false|function} [opts.log]     where notes go (default stderr)
 * @returns {Promise<{cssPath:string, htmlPath:string, inlineRules:number,
 *   resolvedKept:number, resolvedDropped:number, atRulesDropped:number,
 *   autoSafelist:boolean, wrote:boolean}>}
 */
async function resolveFile(inputPath, opts = {}) {
  const cssPath = opts.css || path.join(path.dirname(inputPath), 'styles.css');
  const htmlOutFor = (f) => (opts.inPlace ? f : opts.htmlOut || cleanedPath(f));
  const r = await resolvePages([inputPath], opts, cssPath, htmlOutFor);
  const { files, ...rest } = r;
  return { ...rest, htmlPath: files[0].htmlPath };
}

/**
 * Resolve mode for a whole directory: the union of classes used by every
 * .html/.htm page (skipping node_modules and dot-dirs), one shared output
 * stylesheet, inline styles deduplicated across pages, and per-page links.
 * @param {string} dir
 * @param {object} opts  same as resolveFile (htmlOut is ignored)
 * @returns {Promise<{cssPath:string, files:Array<{htmlPath:string}>, inlineRules:number,
 *   resolvedKept:number, resolvedDropped:number, atRulesDropped:number,
 *   autoSafelist:boolean, wrote:boolean}>}
 */
async function resolveDirectory(dir, opts = {}) {
  const cssPath = opts.css || path.join(dir, 'styles.css');
  const files = listHtmlFiles(dir);
  return resolvePages(files, opts, cssPath, (f) => (opts.inPlace ? f : cleanedPath(f)));
}

module.exports = {
  parseDeclarations,
  canonical,
  convert,
  renderStylesheet,
  parseExistingCss,
  convertFile,
  convertDirectory,
  resolveFile,
  resolveDirectory,
  collectUsedClasses,
  selectorIsUsed,
  resolveStylesheet,
  loadCssSource,
  detectBootstrap,
  BOOTSTRAP_PRESET,
  FRAMEWORK_LAYER,
};

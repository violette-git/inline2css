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
const { collectUsedClasses, resolveStylesheet } = require('./resolve');

/**
 * Load CSS text from a source that may be a local file path or an http(s) URL.
 * @param {string} src
 * @param {string} baseDir  directory to resolve relative file paths against
 * @returns {Promise<string>}
 */
async function loadCssSource(src, baseDir) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch ${src}: ${res.status}`);
    return res.text();
  }
  const p = path.isAbsolute(src) ? src : path.join(baseDir, src);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Gather all stylesheet sources for resolve mode: explicit --resolve entries
 * plus (optionally) <link rel="stylesheet"> hrefs discovered in the HTML.
 * @returns {Promise<string>} concatenated CSS
 */
async function gatherCss(html, htmlDir, resolveSources, includeLinkedSheets) {
  const parts = [];
  const seen = new Set();

  // Linked sheets: hrefs are relative to the HTML file's directory.
  if (includeLinkedSheets) {
    const $ = load(html);
    const hrefs = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) hrefs.push(href);
    });
    for (const href of hrefs) {
      if (seen.has(href)) continue;
      seen.add(href);
      try {
        parts.push(await loadCssSource(href, htmlDir));
      } catch (e) {
        process.stderr.write(`warn: could not load linked sheet ${href}: ${e.message}\n`);
      }
    }
  }

  // Explicit --resolve sources: relative to the current working directory.
  for (const src of resolveSources || []) {
    if (seen.has(src)) continue;
    seen.add(src);
    parts.push(await loadCssSource(src, process.cwd()));
  }

  return parts.join('\n');
}

/**
 * Remove <link rel="stylesheet"> tags whose href was resolved/inlined, and
 * inject a single <link> to the new stylesheet.
 */
function rewriteLinks($, newHref, removedHrefs) {
  const removeSet = new Set(removedHrefs);
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (removeSet.has(href)) $(el).remove();
  });
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
    const single = /^\.([A-Za-z_][-\w]*)$/.exec(selector);
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

  const cssText = renderStylesheet(rules, opts.minify);

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

  const htmlFiles = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.html?$/i.test(entry.name)) {
        htmlFiles.push(full);
      }
    }
  })(dir);

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
    let htmlPath;
    if (opts.inPlace) htmlPath = file;
    else {
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      htmlPath = path.join(path.dirname(file), `${base}.cleaned${ext}`);
    }
    if (!opts.dryRun) fs.writeFileSync(htmlPath, newHtml, 'utf8');
    results.push({ htmlPath });
  }

  const cssText = renderStylesheet(Array.from(registry.values()), opts.minify);
  if (!opts.dryRun) fs.writeFileSync(cssPath, cssText, 'utf8');

  return {
    cssPath,
    files: results,
    ruleCount: registry.size,
    wrote: !opts.dryRun,
  };
}

/**
 * Resolve mode (Model 1): extract inline styles AND tree-shake framework
 * stylesheets down to the rules the HTML actually uses, emitting one combined
 * stylesheet. Framework classes are preserved in the HTML as hooks; inline
 * styles and resolved <link> tags are removed.
 *
 * @param {string} inputPath
 * @param {object} opts
 *   @param {string[]} [opts.resolve]        extra stylesheet paths/URLs
 *   @param {boolean}  [opts.resolveLinked]  also resolve <link> sheets in HTML
 *   @param {string}   [opts.css]            output css path
 *   @param {string}   [opts.htmlOut]
 *   @param {boolean}  [opts.inPlace]
 *   @param {boolean}  [opts.dryRun]
 *   @param {boolean}  [opts.minify]
 *   @param {boolean}  [opts.keepAtRules=true]
 *   @param {string}   [opts.naming], [opts.prefix]  (for inline extraction)
 * @returns {Promise<{cssPath:string, htmlPath:string, inlineRules:number,
 *   resolvedKept:number, resolvedDropped:number, wrote:boolean}>}
 */
async function resolveFile(inputPath, opts = {}) {
  const original = fs.readFileSync(inputPath, 'utf8');
  const dir = path.dirname(inputPath);
  const cssPath = opts.css || path.join(dir, 'styles.css');
  const cssHref = path.basename(cssPath);

  // Step 1: inline-style extraction (no link injection yet; we manage links).
  const { html: afterInline, rules: inlineRules } = convert(original, {
    prefix: opts.prefix || 'i2c-',
    naming: opts.naming || 'sequential',
    cssHref,
    injectLink: false,
  });

  // Step 2: determine used classes AFTER inline extraction (extraction may
  // have added i2c- classes, which we also want represented).
  const $ = load(afterInline);
  const used = collectUsedClasses($);

  // Step 3: gather framework CSS from --resolve sources and/or linked sheets.
  const linkedHrefs = [];
  if (opts.resolveLinked) {
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href !== cssHref) linkedHrefs.push(href);
    });
  }
  const cssText = await gatherCss(
    afterInline,
    dir,
    opts.resolve,
    opts.resolveLinked,
  );

  // Step 4: tree-shake.
  const resolved = cssText.trim()
    ? resolveStylesheet(cssText, used, {
        minify: opts.minify,
        keepAtRules: opts.keepAtRules !== false,
      })
    : { css: '', keptRules: 0, droppedRules: 0 };

  // Step 5: combine inline-extracted rules + resolved framework rules.
  const inlineCss = renderStylesheet(inlineRules, opts.minify);
  const combined = [resolved.css, inlineCss]
    .filter((s) => s && s.trim())
    .join(opts.minify ? '' : '\n');

  // Step 6: rewrite links (drop resolved sheets, add ours).
  rewriteLinks($, cssHref, linkedHrefs);
  const newHtml = $.html();

  // Step 7: outputs.
  let htmlPath;
  if (opts.inPlace) htmlPath = inputPath;
  else if (opts.htmlOut) htmlPath = opts.htmlOut;
  else {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    htmlPath = path.join(dir, `${base}.cleaned${ext}`);
  }

  if (!opts.dryRun) {
    fs.writeFileSync(cssPath, combined + (opts.minify ? '' : '\n'), 'utf8');
    fs.writeFileSync(htmlPath, newHtml, 'utf8');
  }

  return {
    cssPath,
    htmlPath,
    inlineRules: inlineRules.length,
    resolvedKept: resolved.keptRules,
    resolvedDropped: resolved.droppedRules,
    wrote: !opts.dryRun,
  };
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
  collectUsedClasses,
  resolveStylesheet,
  loadCssSource,
};

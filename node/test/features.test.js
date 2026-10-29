'use strict';

// Tests for the v1.1 behavior spec (items 1 to 10).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');
const csstree = require('css-tree');

const {
  collectUsedClasses,
  selectorIsUsed,
  resolveStylesheet,
  resolveFile,
  resolveDirectory,
  convert,
  renderStylesheet,
  detectBootstrap,
} = require('../src/index');
const { prettifyCss, makeClassPool, rewriteUrlValue } = require('../src/resolve');

const used = (html) => collectUsedClasses(load(html));
const sel = (s) => csstree.parse(s, { context: 'selector' });
const isUsed = (s, classes) => selectorIsUsed(sel(s), new Set(classes), true);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-v11-'));
const quiet = { log: false };

describe('1. selector matching', () => {
  test(':not() classes are never required', () => {
    assert.strictEqual(isUsed(':not(.btn-check)+.btn:active', ['btn']), true);
    assert.strictEqual(isUsed('.btn:not(.disabled)', ['btn']), true);
    assert.strictEqual(isUsed(':not(.btn-check)+.btn:active', ['other']), false);
  });

  test(':where() needs any satisfiable branch (Tailwind v4 space-y)', () => {
    const s = ':where(.space-y-2 > :not(:last-child))';
    assert.strictEqual(isUsed(s, ['space-y-2']), true);
    assert.strictEqual(isUsed(s, ['nope']), false);
  });

  test(':is() / :matches() / vendor any() are any-of', () => {
    assert.strictEqual(isUsed(':is(.a, .b) .c', ['b', 'c']), true);
    assert.strictEqual(isUsed(':is(.a, .b) .c', ['c']), false);
    assert.strictEqual(isUsed(':matches(.a, .b)', ['a']), true);
    assert.strictEqual(isUsed(':-webkit-any(.a, .b)', ['b']), true);
    assert.strictEqual(isUsed(':-moz-any(.a, .b)', ['z']), false);
    assert.strictEqual(isUsed(':is(.a, div) .c', ['c']), true); // div branch has no class need
  });

  test(':has() is any-of over its relative selectors', () => {
    assert.strictEqual(isUsed('.card:has(> .img)', ['card', 'img']), true);
    assert.strictEqual(isUsed('.card:has(> .img)', ['card']), false);
    assert.strictEqual(isUsed('.card:has(.a, .b)', ['card', 'b']), true);
  });

  test('nested any-of inside :not() inside :is()', () => {
    assert.strictEqual(isUsed(':is(.a:not(.x))', ['a']), true);
    assert.strictEqual(isUsed(':is(:where(.a), .b)', ['a']), true);
    assert.strictEqual(isUsed(':is(:where(.a), .b)', ['c']), false);
  });

  test('other functional pseudos ignore their classes (conservative)', () => {
    assert.strictEqual(isUsed('li:nth-child(2n of .x)', []), true);
    assert.strictEqual(isUsed('.a:nth-child(2n of .x)', ['a']), true);
    assert.strictEqual(isUsed(':host(.dark) .a', ['a']), true);
    assert.strictEqual(isUsed('::slotted(.x)', []), true);
    assert.strictEqual(isUsed('.a::part(label)', ['a']), true);
  });

  test('top-level classes in every compound are still required', () => {
    assert.strictEqual(isUsed('.a.b', ['a']), false);
    assert.strictEqual(isUsed('.a > .b:hover', ['a', 'b']), true);
  });

  test('selector lists keep only the satisfiable selectors', () => {
    const r = resolveStylesheet('.a, .b, :not(.c) + .d { color: red }', used('<i class="a d"></i>'), { minify: true });
    assert.strictEqual(r.css, '.a,:not(.c)+.d{color:red}');
    const none = resolveStylesheet('.x, .y { color: red }', used('<i class="a"></i>'), { minify: true });
    assert.strictEqual(none.css, '');
    assert.strictEqual(none.droppedRules, 1);
  });

  test('hex escapes and \\: escapes are unescaped before matching', () => {
    assert.strictEqual(isUsed('.md\\3A flex', ['md:flex']), true);
    assert.strictEqual(isUsed('.\\31 0', ['10']), true);
  });
});

describe('2. safelist', () => {
  test('plain names and /regex/ entries keep rules', () => {
    const css = '.tooltip-x{a:b}.keepme{c:d}.gone{e:f}';
    const r = resolveStylesheet(css, used('<p></p>'), { minify: true, safelist: ['keepme', '/^tooltip/'] });
    assert.strictEqual(r.css, '.tooltip-x{a:b}.keepme{c:d}');
  });

  test('RegExp objects work in the library option', () => {
    const r = resolveStylesheet('.bs-tooltip-top{a:b}', used('<p></p>'), { minify: true, safelist: [/^bs-/] });
    assert.strictEqual(r.keptRules, 1);
  });

  test('bootstrap preset covers runtime classes and patterns', () => {
    const pool = makeClassPool([], require('../src/resolve').BOOTSTRAP_PRESET);
    for (const c of ['show', 'collapsing', 'modal-backdrop', 'was-validated', 'toast', 'bs-tooltip-top', 'bs-popover-end']) {
      assert.ok(pool.has(c), c);
    }
    assert.strictEqual(pool.has('btn'), false);
    const r = resolveStylesheet('.fade.show{opacity:1}', used('<p class="fade"></p>'), {
      minify: true,
      safelistPreset: 'bootstrap',
    });
    assert.strictEqual(r.keptRules, 1);
  });

  test('auto-detect: bootstrap script src or data-bs-* attribute', () => {
    assert.strictEqual(detectBootstrap(load('<script src="js/bootstrap.bundle.min.js"></script>')), true);
    assert.strictEqual(detectBootstrap(load('<script src="https://cdn.x/bootstrap.js"></script>')), true);
    assert.strictEqual(detectBootstrap(load('<button data-bs-toggle="modal">x</button>')), true);
    assert.strictEqual(detectBootstrap(load('<script src="app.js"></script><p data-x="1"></p>')), false);
  });

  test('resolveFile applies the preset when detected, prints one note, and can be disabled', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.modal{a:b}.modal.show{display:block}.unused{c:d}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<html><head></head><body><div class="modal" data-bs-backdrop="static"></div></body></html>');
    const notes = [];
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, log: (m) => notes.push(m) });
    assert.strictEqual(r.autoSafelist, true);
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0], /Bootstrap/);
    assert.match(fs.readFileSync(r.cssPath, 'utf8'), /\.modal\.show/);

    const r2 = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, autoSafelist: false, ...quiet });
    assert.strictEqual(r2.autoSafelist, false);
    assert.doesNotMatch(fs.readFileSync(r2.cssPath, 'utf8'), /\.show/);
  });
});

describe('3. precedence: layering and --boost', () => {
  test('resolve output wraps framework in @layer and puts inline rules after, unlayered', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '@charset "UTF-8";.navbar-nav .nav-link{padding:8px}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<ul class="navbar-nav"><li><a class="nav-link" style="padding:0 40px">x</a></li></ul>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, ...quiet });
    const css = fs.readFileSync(r.cssPath, 'utf8');
    assert.strictEqual(css, '@layer inline2css-framework{.navbar-nav .nav-link{padding:8px}}.i2c-1{padding:0 40px}');
  });

  test('@import is hoisted to the very top with layer(), keeping media; @namespace hoisted; @charset dropped', () => {
    const css =
      '@charset "UTF-8";.a{color:red}@import url(x.css) screen and (min-width:1px);@import "y.css";@namespace svg url(http://www.w3.org/2000/svg);';
    const r = resolveStylesheet(css, used('<i class="a"></i>'), { minify: true, layer: true });
    assert.strictEqual(
      r.css,
      '@import url(x.css) layer(inline2css-framework) screen and (min-width:1px);' +
        '@import url(y.css) layer(inline2css-framework);' +
        '@namespace svg url(http://www.w3.org/2000/svg);' +
        '@layer inline2css-framework{.a{color:red}}',
    );
  });

  test('an @import that already has layer(name) nests under the framework layer', () => {
    const r = resolveStylesheet('@import url(t.css) layer(theme);', new Set(), { minify: true, layer: true });
    assert.strictEqual(r.css, '@import url(t.css) layer(inline2css-framework.theme);');
  });

  test('--no-layer (layer: false) emits plain framework CSS', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '@import url(x.css);.a{b:c}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="a" style="color:red">x</p>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, layer: false, ...quiet });
    assert.strictEqual(fs.readFileSync(r.cssPath, 'utf8'), '@import url(x.css);.a{b:c}.i2c-1{color:red}');
  });

  test('extracted !important declarations go to a layer ordered before the framework', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.p-0{padding:0!important}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="p-0" style="padding:5px !important;color:red">x</p>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, ...quiet });
    assert.strictEqual(
      fs.readFileSync(r.cssPath, 'utf8'),
      '@layer inline2css-important,inline2css-framework;@layer inline2css-framework{.p-0{padding:0!important}}' +
        '.i2c-1{color:red}@layer inline2css-important{.i2c-1{padding:5px !important}}',
    );
  });

  test('--boost adds :not(#\\#) in basic mode', () => {
    const { rules } = convert('<p style="color:red">x</p>');
    assert.strictEqual(renderStylesheet(rules, true, { boost: true }), '.i2c-1:not(#\\#){color:red}');
    assert.match(renderStylesheet(rules, false, { boost: true }), /^\.i2c-1:not\(#\\#\) \{/);
  });

  test('--boost in resolve mode, and the boosted selector parses as one id of specificity', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.a{b:c}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="a" style="color:red">x</p>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], minify: true, boost: true, ...quiet });
    const css = fs.readFileSync(r.cssPath, 'utf8');
    assert.match(css, /\.i2c-1:not\(#\\#\)\{color:red\}$/);
    let ids = 0;
    csstree.walk(csstree.parse('.i2c-1:not(#\\#){}'), { visit: 'IdSelector', enter() { ids += 1; } });
    assert.strictEqual(ids, 1);
  });

  test('basic convertFile honors boost', () => {
    const dir = tmp();
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p style="color:red">x</p>');
    const r = require('../src/index').convertFile(input, { boost: true, minify: true });
    assert.strictEqual(fs.readFileSync(r.cssPath, 'utf8'), '.i2c-1:not(#\\#){color:red}');
  });
});

describe('4. dead at-rule pruning', () => {
  const kf = '@keyframes spin{to{transform:rotate(1turn)}}@keyframes unused{to{opacity:0}}';

  test('drops @keyframes unless referenced by animation / animation-name', () => {
    const r = resolveStylesheet(kf + '.s{animation:spin 1s linear}', used('<i class="s"></i>'), { minify: true });
    assert.match(r.css, /@keyframes spin/);
    assert.doesNotMatch(r.css, /unused/);
    assert.strictEqual(r.droppedAtRules, 1);
    const r2 = resolveStylesheet(kf + '.s{animation-name:unused}', used('<i class="s"></i>'), { minify: true });
    assert.match(r2.css, /@keyframes unused/);
    assert.doesNotMatch(r2.css, /spin/);
  });

  test('keyframes whose only user was tree-shaken away are dropped', () => {
    const r = resolveStylesheet(kf + '.s{animation:spin 1s}', used('<i class="x"></i>'), { minify: true });
    assert.strictEqual(r.css, '');
  });

  test('follows var() through custom properties (Bootstrap spinner, Tailwind animate)', () => {
    const css =
      '@keyframes spinner-border{to{transform:rotate(360deg)}}' +
      '.spinner-border{--bs-spinner-animation-name:spinner-border;animation:var(--bs-spinner-animation-speed) linear infinite var(--bs-spinner-animation-name)}';
    const r = resolveStylesheet(css, used('<i class="spinner-border"></i>'), { minify: true });
    assert.match(r.css, /@keyframes spinner-border/);
    const tw = ':root{--animate-pulse:pulse 2s infinite}@keyframes pulse{50%{opacity:.5}}.animate-pulse{animation:var(--animate-pulse)}';
    assert.match(resolveStylesheet(tw, used('<i class="animate-pulse"></i>'), { minify: true }).css, /@keyframes pulse/);
  });

  test('extracted inline declarations count as usage', () => {
    const r = resolveStylesheet(kf, new Set(), { minify: true, inlineDecls: [{ prop: 'animation', value: 'unused 2s' }] });
    assert.match(r.css, /@keyframes unused/);
  });

  test('drops @font-face unless its family is used by font / font-family', () => {
    const ff = '@font-face{font-family:"Brand Sans";src:url(b.woff2)}@font-face{font-family:Other;src:url(o.woff2)}';
    const r = resolveStylesheet(ff + 'body{font:16px/1.5 "Brand Sans", sans-serif}', new Set(), { minify: true });
    assert.match(r.css, /@font-face\{font-family:"Brand Sans"/);
    const sh = resolveStylesheet(ff + 'body{font:italic 700 16px/2 Brand Sans}', new Set(), { minify: true });
    assert.match(sh.css, /@font-face\{font-family:"Brand Sans"/);
    assert.doesNotMatch(r.css, /Other/);
    const r2 = resolveStylesheet(ff + 'p{font-family:other}', new Set(), { minify: true });
    assert.match(r2.css, /@font-face\{font-family:Other/);
    assert.doesNotMatch(r2.css, /Brand/);
  });

  test('keepAllAtRules keeps everything', () => {
    const r = resolveStylesheet(kf, new Set(), { minify: true, keepAllAtRules: true });
    assert.match(r.css, /spin/);
    assert.match(r.css, /unused/);
  });

  test('keyframe selectors (from, 50%) are never tree-shaken', () => {
    const r = resolveStylesheet('@keyframes k{from{a:b}50%{c:d}}.k{animation:k}', used('<i class="k"></i>'), { minify: true });
    assert.match(r.css, /from\{a:b\}50%\{c:d\}/);
  });
});

describe('5. url() rewriting', () => {
  test('rewriteUrlValue skips data:, http(s):, //, /abs and #frag', () => {
    const ctx = { from: '/a/vendor/css/fw.css', to: '/a/out/styles.css' };
    for (const u of ['data:image/png;base64,xx', 'https://x/y.png', 'http://x/y.png', '//cdn/y.png', '/abs/y.png', '#frag']) {
      assert.strictEqual(rewriteUrlValue(u, ctx), null, u);
    }
    assert.strictEqual(rewriteUrlValue('../fonts/a.woff2?v=1#x', ctx), '../vendor/fonts/a.woff2?v=1#x');
    assert.strictEqual(rewriteUrlValue('img.png', { from: '/a/x.css', to: '/a/y.css' }), null);
  });

  test('local file in another directory: relative urls point at the same file', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'vendor', 'css'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'vendor', 'css', 'fw.css'),
      '@import "theme.css";.a{background:url("../img/a.png")}.b{background:url(data:image/png;base64,AAAA)}' +
        '.c{background:url(/abs.png)}.d{--icon:url(\'icons/i.svg\')}',
    );
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="a b c d">x</p>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'vendor', 'css', 'fw.css')], minify: true, ...quiet });
    const css = fs.readFileSync(r.cssPath, 'utf8');
    assert.match(css, /url\(vendor\/img\/a\.png\)/);
    assert.match(css, /url\(data:image\/png;base64,AAAA\)/);
    assert.match(css, /url\(\/abs\.png\)/);
    assert.match(css, /--icon:url\(vendor\/css\/icons\/i\.svg\)/);
    assert.match(css, /^@import url\(vendor\/css\/theme\.css\) layer\(inline2css-framework\);/);
  });

  test('http(s) source: relative urls become absolute (mocked fetch)', async () => {
    const dir = tmp();
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<html><head><link rel="stylesheet" href="https://cdn.example.com/lib/5.3/css/fw.min.css"></head><body><p class="a">x</p></body></html>');
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (u) => {
      calls.push(u);
      return { ok: true, status: 200, text: async () => '.a{background:url(../img/bg.png)}.z{color:red}.a::after{content:url(//x/y.png)}' };
    };
    try {
      const r = await resolveFile(input, { resolveLinked: true, minify: true, ...quiet });
      const css = fs.readFileSync(r.cssPath, 'utf8');
      assert.deepStrictEqual(calls, ['https://cdn.example.com/lib/5.3/css/fw.min.css']);
      assert.match(css, /url\(https:\/\/cdn\.example\.com\/lib\/5\.3\/img\/bg\.png\)/);
      assert.match(css, /url\(\/\/x\/y\.png\)/);
      assert.doesNotMatch(css, /\.z/);
      assert.doesNotMatch(fs.readFileSync(r.htmlPath, 'utf8'), /cdn\.example\.com/);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('failed fetch of an explicit --resolve URL rejects with a clear error', async () => {
    const dir = tmp();
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="a">x</p>');
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    try {
      await assert.rejects(resolveFile(input, { resolve: ['https://x.test/a.css'], ...quiet }), /404/);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('6. link removal (regression)', () => {
  test('protocol-relative linked sheets are fetched over https and removed', async () => {
    const dir = tmp();
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<html><head><link rel="stylesheet" href="//cdn.x/fw.css"></head><body><p class="a">x</p></body></html>');
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (u) => {
      calls.push(u);
      return { ok: true, status: 200, text: async () => '.a{color:red}' };
    };
    try {
      const r = await resolveFile(input, { resolveLinked: true, minify: true, ...quiet });
      assert.deepStrictEqual(calls, ['https://cdn.x/fw.css']);
      assert.doesNotMatch(fs.readFileSync(r.htmlPath, 'utf8'), /cdn\.x/);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('explicit --resolve removes the matching link by basename, query string stripped', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'vendor'));
    fs.writeFileSync(path.join(dir, 'vendor', 'bootstrap.min.css'), '.btn{color:red}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(
      input,
      '<html><head><link rel="stylesheet" href="https://cdn.x/bootstrap.min.css?v=5.3.8">' +
        '<link rel="stylesheet" href="site.css"></head><body><a class="btn">x</a></body></html>',
    );
    const r = await resolveFile(input, { resolve: [path.join(dir, 'vendor', 'bootstrap.min.css')], ...quiet });
    const out = fs.readFileSync(r.htmlPath, 'utf8');
    assert.doesNotMatch(out, /bootstrap\.min\.css/);
    assert.match(out, /href="site\.css"/); // unrelated sheet stays
    assert.strictEqual((out.match(/href="styles\.css"/g) || []).length, 1);
  });

  test('--resolve-linked removes every folded-in stylesheet link and adds exactly one', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.css'), '.a{color:red}');
    fs.writeFileSync(path.join(dir, 'b.css'), '.b{color:blue}');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(
      input,
      '<html><head><link rel="stylesheet" href="a.css"><link href="b.css" rel="preload stylesheet">' +
        '<link rel="icon" href="fav.ico"></head><body><p class="a b">x</p></body></html>',
    );
    const r = await resolveFile(input, { resolveLinked: true, css: path.join(dir, 'out.css'), minify: true, ...quiet });
    const out = fs.readFileSync(r.htmlPath, 'utf8');
    assert.doesNotMatch(out, /a\.css|b\.css/);
    assert.match(out, /fav\.ico/);
    assert.strictEqual((out.match(/rel="stylesheet"/g) || []).length, 1);
    assert.match(out, /href="out\.css"/);
    assert.strictEqual(fs.readFileSync(r.cssPath, 'utf8'), '@layer inline2css-framework{.a{color:red}.b{color:blue}}');
  });
});

describe('7. resolve on a directory', () => {
  test('union of classes, one css, shared inline registry, per-page hrefs and link removal', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'fw.css'), '.one{a:1}.two{b:2}.three{c:3}.never{d:4}');
    const head = (href) => `<html><head><link rel="stylesheet" href="${href}"></head>`;
    fs.writeFileSync(path.join(dir, 'index.html'), head('fw.css') + '<body><p class="one" style="color:red">x</p></body></html>');
    fs.writeFileSync(path.join(dir, 'docs', 'b.htm'), head('../fw.css') + '<body><p class="two" style="color: red;">y</p></body></html>');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'x.html'), '<p class="three">z</p>');
    fs.writeFileSync(path.join(dir, '.git', 'x.html'), '<p class="three">z</p>');

    const r = await resolveDirectory(dir, { resolveLinked: true, css: path.join(dir, 'assets', 'site.css'), minify: true, ...quiet });
    assert.strictEqual(r.files.length, 2);
    assert.strictEqual(r.inlineRules, 1); // deduped across pages
    const css = fs.readFileSync(r.cssPath, 'utf8');
    assert.strictEqual(css, '@layer inline2css-framework{.one{a:1}.two{b:2}}.i2c-1{color:red}');
    const a = fs.readFileSync(path.join(dir, 'index.cleaned.html'), 'utf8');
    const b = fs.readFileSync(path.join(dir, 'docs', 'b.cleaned.htm'), 'utf8');
    assert.match(a, /href="assets\/site\.css"/);
    assert.match(b, /href="\.\.\/assets\/site\.css"/);
    assert.doesNotMatch(a + b, /fw\.css/);
    assert.match(a, /class="one i2c-1"/);
    assert.match(b, /class="two i2c-1"/);
  });

  test('safelist applies in directory mode; explicit sources work; dry-run writes nothing', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.x{a:1}.keep{b:2}');
    fs.writeFileSync(path.join(dir, 'a.html'), '<p class="x">x</p>');
    const r = await resolveDirectory(dir, { resolve: [path.join(dir, 'fw.css')], safelist: ['keep'], dryRun: true, ...quiet });
    assert.strictEqual(r.resolvedKept, 2);
    assert.strictEqual(fs.existsSync(r.cssPath), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'a.cleaned.html')), false);
  });

  test('cleaned outputs from an earlier run are not treated as input pages', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.x{a:1}');
    fs.writeFileSync(path.join(dir, 'a.html'), '<p class="x">x</p>');
    await resolveDirectory(dir, { resolve: [path.join(dir, 'fw.css')], ...quiet });
    const r = await resolveDirectory(dir, { resolve: [path.join(dir, 'fw.css')], ...quiet });
    assert.strictEqual(r.files.length, 1);
  });
});

describe('8. safe pretty printer', () => {
  test('never breaks inside url("data:...;...")', () => {
    const min = '.a{background-image:url("data:image/svg+xml;charset=utf8,%3csvg{x:y;z}%3e");color:red}';
    const out = prettifyCss(min);
    assert.match(out, /url\("data:image\/svg\+xml;charset=utf8,%3csvg\{x:y;z\}%3e"\);/);
    assert.strictEqual(out, '.a {\n    background-image:url("data:image/svg+xml;charset=utf8,%3csvg{x:y;z}%3e");\n    color:red\n}\n');
  });

  test('never breaks inside strings, comments, brackets or escapes', () => {
    const out = prettifyCss('.a::before{content:"a;b{c}d"}[data-x="1;2"]{color:red}/* x;{y} */.\\;b{c:\'q;}\'}');
    assert.match(out, /content:"a;b\{c\}d"\n/);
    assert.match(out, /\[data-x="1;2"\] \{/);
    assert.match(out, /\/\* x;\{y\} \*\//);
    assert.match(out, /\.\\;b \{/);
    assert.match(out, /c:'q;}'\n/);
  });

  test('pretty output of real Bootstrap-style data URIs still parses to the same declarations', () => {
    const css =
      '.form-select{--bs-form-select-bg-img:url("data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath d=\'m2 5 6 6 6-6\'/%3e%3c/svg%3e");' +
      'background-image:url("data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\'%3e%3c/svg%3e")}';
    const r = resolveStylesheet(css, used('<select class="form-select"></select>'));
    const decls = [];
    csstree.walk(csstree.parse(r.css), { visit: 'Declaration', enter(n) { decls.push(n.property); } });
    assert.deepStrictEqual(decls, ['--bs-form-select-bg-img', 'background-image']);
    for (const line of r.css.split('\n')) {
      const q = (line.match(/"/g) || []).length;
      assert.strictEqual(q % 2, 0, `unbalanced quote on line: ${line}`);
    }
  });
});

describe('10. output order', () => {
  test('hoisted @import / @namespace, then layered framework, then inline rules (pretty)', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fw.css'), '.a{b:c}@namespace svg url(http://www.w3.org/2000/svg);@import url(z.css);');
    const input = path.join(dir, 'p.html');
    fs.writeFileSync(input, '<p class="a" style="color:red">x</p>');
    const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')], ...quiet });
    const css = fs.readFileSync(r.cssPath, 'utf8');
    const idx = (s) => css.indexOf(s);
    assert.strictEqual(idx('@import'), 0);
    assert.ok(idx('@import') < idx('@namespace'));
    assert.ok(idx('@namespace') < idx('@layer inline2css-framework'));
    assert.ok(idx('@layer inline2css-framework') < idx('.i2c-1'));
    assert.match(css, /\}\n\n\.i2c-1 \{\n    color: red;\n\}\n$/);
  });
});

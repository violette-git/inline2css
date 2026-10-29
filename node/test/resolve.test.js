'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');

const { collectUsedClasses, resolveStylesheet, resolveFile } = require('../src/index');

function used(html) {
  return collectUsedClasses(load(html));
}

test('keeps used class rules, drops unused', () => {
  const html = '<div class="a"></div>';
  const css = '.a{color:red}.b{color:blue}';
  const r = resolveStylesheet(css, used(html), { minify: true });
  assert.strictEqual(r.css, '.a{color:red}');
  assert.strictEqual(r.droppedRules, 1);
});

test('descendant selector needs all classes present', () => {
  const css = '.card>.title{font-weight:bold}';
  assert.strictEqual(resolveStylesheet(css, used('<div class="card"></div>'), {minify:true}).keptRules, 0);
  assert.strictEqual(resolveStylesheet(css, used('<div class="card"><i class="title"></i></div>'), {minify:true}).keptRules, 1);
});

test('preserves hover pseudo-state', () => {
  const css = '.btn:hover{color:red}';
  const r = resolveStylesheet(css, used('<a class="btn">x</a>'), { minify: true });
  assert.match(r.css, /\.btn:hover/);
});

test('preserves media query and prunes inside it', () => {
  const css = '@media (min-width:768px){.a{color:red}.z{color:blue}}';
  const r = resolveStylesheet(css, used('<p class="a">x</p>'), { minify: true });
  assert.match(r.css, /@media/);
  assert.match(r.css, /\.a\{color:red\}/);
  assert.doesNotMatch(r.css, /\.z/);
});

test('drops fully-empty media block', () => {
  const css = '@media (min-width:768px){.z{color:blue}}';
  const r = resolveStylesheet(css, used('<p class="a">x</p>'), { minify: true });
  assert.doesNotMatch(r.css, /@media/);
});

test('matches escaped tailwind class md:flex', () => {
  const css = '.md\\:flex{display:flex}';
  const r = resolveStylesheet(css, used('<nav class="md:flex"></nav>'), { minify: true });
  assert.strictEqual(r.keptRules, 1);
});

test('matches arbitrary-value class p-[13px]', () => {
  const css = '.p-\\[13px\\]{padding:13px}';
  const r = resolveStylesheet(css, used('<div class="p-[13px]">x</div>'), { minify: true });
  assert.strictEqual(r.keptRules, 1);
});

test('keeps bare element selectors by default', () => {
  const r = resolveStylesheet('body{margin:0}', used('<body></body>'), { minify: true });
  assert.match(r.css, /body/);
});

test('resolveFile combines inline extraction + tree-shake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-res-'));
  fs.writeFileSync(path.join(dir, 'fw.css'), '.btn{color:red}.unused{color:blue}');
  const input = path.join(dir, 'p.html');
  fs.writeFileSync(input, '<body><button class="btn" style="margin:5px">x</button></body>');
  const r = await resolveFile(input, { resolve: [path.join(dir, 'fw.css')] });
  const css = fs.readFileSync(r.cssPath, 'utf8');
  const outHtml = fs.readFileSync(r.htmlPath, 'utf8');
  assert.match(css, /\.btn/);
  assert.doesNotMatch(css, /unused/);
  assert.match(css, /i2c-1/);          // inline style extracted
  assert.doesNotMatch(outHtml, /style=/); // inline removed
  assert.match(outHtml, /class="btn i2c-1"/); // framework class kept as hook
});

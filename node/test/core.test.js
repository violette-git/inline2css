'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  parseDeclarations,
  canonical,
  convert,
  renderStylesheet,
  parseExistingCss,
  convertFile,
  convertDirectory,
} = require('../src/index');

test('parses basic declarations', () => {
  assert.deepStrictEqual(parseDeclarations('color:blue; padding: 3px;'), [
    { prop: 'color', value: 'blue' },
    { prop: 'padding', value: '3px' },
  ]);
});

test('tolerates missing trailing semicolon', () => {
  assert.deepStrictEqual(parseDeclarations('color:red'), [
    { prop: 'color', value: 'red' },
  ]);
});

test('keeps semicolons inside url()', () => {
  const d = parseDeclarations('background-image: url(a.png; b.png); color: red');
  assert.strictEqual(d[0].value, 'url(a.png; b.png)');
  assert.strictEqual(d[1].value, 'red');
});

test('empty style yields no declarations', () => {
  assert.deepStrictEqual(parseDeclarations('   '), []);
});

test('duplicate property is last-wins', () => {
  assert.deepStrictEqual(parseDeclarations('color:red; color:blue'), [
    { prop: 'color', value: 'blue' },
  ]);
});

test('canonical is order-independent', () => {
  const a = parseDeclarations('color:red; padding:1px');
  const b = parseDeclarations('padding:1px; color:red');
  assert.strictEqual(canonical(a), canonical(b));
});

test('convert dedups identical styles into one class', () => {
  const html = '<p style="color:blue">x</p><p style="color: blue;">y</p>';
  const { html: out, rules } = convert(html);
  assert.strictEqual(rules.length, 1);
  assert.match(out, /class="i2c-1"/);
  assert.doesNotMatch(out, /style=/);
});

test('convert preserves existing classes', () => {
  const { html: out } = convert('<div class="row" style="color:blue">x</div>');
  assert.match(out, /class="row i2c-1"/);
});

test('convert injects link into head', () => {
  const html = '<html><head></head><body><p style="color:red">x</p></body></html>';
  const { html: out } = convert(html, { cssHref: 'styles.css' });
  assert.match(out, /<link rel="stylesheet" href="styles.css">/);
});

test('hash naming is deterministic', () => {
  const a = convert('<p style="color:red">x</p>', { naming: 'hash' }).rules[0].className;
  const b = convert('<p style="color:red">y</p>', { naming: 'hash' }).rules[0].className;
  assert.strictEqual(a, b);
  assert.match(a, /^i2c-[0-9a-f]{6}$/);
});

test('semantic naming derives from first declaration', () => {
  const cls = convert('<p style="color:red">x</p>', { naming: 'semantic' }).rules[0].className;
  assert.match(cls, /^i2c-color-red-[0-9a-f]{4}$/);
});

test('minify produces compact rules', () => {
  const { rules } = convert('<p style="color:red;padding:1px">x</p>');
  const css = renderStylesheet(rules, true);
  assert.strictEqual(css, '.i2c-1{color:red;padding:1px}');
});

test('parseExistingCss round-trips single-class rules', () => {
  const reg = parseExistingCss('.foo { color: red; }\n.bar{padding:1px}');
  assert.strictEqual(reg.size, 2);
});

test('merge reuses existing class names', () => {
  const registry = parseExistingCss('.brand { color: red; }');
  const counter = { n: registry.size };
  const { html: out } = convert('<p style="color:red">x</p>', { registry, counter });
  assert.match(out, /class="brand"/);
});

test('convertFile writes css and cleaned html', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-'));
  const input = path.join(dir, 'page.html');
  fs.writeFileSync(input, '<body><p style="color:red">x</p></body>');
  const r = convertFile(input);
  assert.ok(fs.existsSync(r.cssPath));
  assert.ok(fs.existsSync(r.htmlPath));
  assert.doesNotMatch(fs.readFileSync(r.htmlPath, 'utf8'), /style=/);
});

test('dry-run writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-'));
  const input = path.join(dir, 'page.html');
  fs.writeFileSync(input, '<body><p style="color:red">x</p></body>');
  const r = convertFile(input, { dryRun: true });
  assert.strictEqual(fs.existsSync(r.cssPath), false);
  assert.strictEqual(r.wrote, false);
});

test('convertDirectory shares one stylesheet across files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-'));
  fs.writeFileSync(path.join(dir, 'a.html'), '<body><p style="color:red">a</p></body>');
  fs.writeFileSync(path.join(dir, 'b.html'), '<body><p style="color:red">b</p></body>');
  const r = convertDirectory(dir);
  assert.strictEqual(r.ruleCount, 1); // deduped across both files
  assert.strictEqual(r.files.length, 2);
});

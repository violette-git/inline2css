'use strict';

// CLI polish (spec item 9) plus end-to-end flag wiring.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const pkg = require('../package.json');
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'i2c-cli-'));

test('--version and -v print the package version', () => {
  for (const flag of ['--version', '-v']) {
    const r = run([flag]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), pkg.version);
  }
  assert.strictEqual(pkg.version, '1.1.0');
  assert.strictEqual(pkg.engines.node, '>=18');
});

test('--help lists every flag', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  for (const f of [
    '--css', '--html-out', '--naming', '--prefix', '--minify', '--merge', '--in-place', '--dry-run',
    '--boost', '--resolve ', '--resolve-linked', '--safelist ', '--safelist-preset', '--no-auto-safelist',
    '--no-layer', '--keep-all-at-rules', '--version', '--help',
  ]) {
    assert.ok(r.stdout.includes(f), `help is missing ${f}`);
  }
  assert.doesNotMatch(r.stdout, /--keep-at-rules|--no-keep-at-rules/);
  assert.doesNotMatch(r.stdout, /\u2014/); // no em-dashes
});

test('unknown flags give a clear error and exit 2', () => {
  const r = run(['page.html', '--frobnicate']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Unknown option: --frobnicate/);
  const old = run(['page.html', '--no-keep-at-rules']);
  assert.strictEqual(old.status, 2);
});

test('missing input exits 1', () => {
  const none = run([]);
  assert.strictEqual(none.status, 1);
  assert.match(none.stderr, /missing input/);
  const gone = run(['does-not-exist.html']);
  assert.strictEqual(gone.status, 1);
  assert.match(gone.stderr, /input not found/);
});

test('a value flag without a value is an error', () => {
  const r = run(['x.html', '--css']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--css needs a value/);
});

test('resolve flags end to end: safelist regex, --no-layer, --boost, --keep-all-at-rules', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fw.css'), '@keyframes k{to{opacity:0}}.a{b:c}.tooltip-x{d:e}.gone{f:g}');
  fs.writeFileSync(path.join(dir, 'p.html'), '<p class="a" style="color:red">x</p>');
  const r = run(
    ['p.html', '--resolve', 'fw.css', '--safelist', '/^tooltip/', '--no-layer', '--boost', '--keep-all-at-rules', '--minify'],
    dir,
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'),
    '@keyframes k{to{opacity:0}}.a{b:c}.tooltip-x{d:e}.i2c-1:not(#\\#){color:red}',
  );
});

test('auto-detect prints one note line; --no-auto-safelist silences it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fw.css'), '.fade{a:b}.fade.show{c:d}');
  fs.writeFileSync(path.join(dir, 'p.html'), '<div class="fade" data-bs-toggle="x"></div>');
  const r = run(['p.html', '--resolve', 'fw.css', '--minify'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /note: Bootstrap JavaScript detected/);
  assert.match(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /\.fade\.show/);
  const r2 = run(['p.html', '--resolve', 'fw.css', '--minify', '--no-auto-safelist'], dir);
  assert.strictEqual(r2.stderr, '');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /\.show/);
});

test('resolve accepts a directory', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fw.css'), '.a{b:c}');
  fs.writeFileSync(path.join(dir, 'one.html'), '<link rel="stylesheet" href="fw.css"><p class="a">x</p>');
  fs.writeFileSync(path.join(dir, 'two.html'), '<link rel="stylesheet" href="fw.css"><p class="a">y</p>');
  const r = run(['.', '--resolve-linked'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 HTML file\(s\)/);
  assert.ok(fs.existsSync(path.join(dir, 'styles.css')));
});

test('unknown --safelist-preset is rejected', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'p.html'), '<p>x</p>');
  const r = run(['p.html', '--resolve-linked', '--safelist-preset', 'foundation'], dir);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /unknown --safelist-preset/);
});

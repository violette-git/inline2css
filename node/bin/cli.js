#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { convertFile, convertDirectory, resolveFile } = require('../src/index');

const HELP = `inline2css - move inline HTML styles into an external stylesheet

Usage:
  inline2css <input.html|dir> [options]

Options:
  --css <path>         Output CSS path (default: <dir>/styles.css)
  --html-out <path>    Output HTML path (single file only)
  --naming <mode>      sequential | hash | semantic  (default: sequential)
  --prefix <str>       Class prefix (default: i2c-)
  --minify             Minify the CSS output
  --merge              Merge into an existing stylesheet, reusing classes
  --in-place           Overwrite the input HTML in place
  --dry-run            Report what would happen without writing files
  --resolve <src>      Tree-shake a stylesheet (file or URL) into styles.css,
                       keeping only rules the HTML uses. Repeatable.
  --resolve-linked     Also resolve <link rel=stylesheet> sheets found in the
                       HTML (e.g. a Bootstrap CDN link), then drop those links.
  --keep-at-rules      Keep @keyframes/@font-face/@import (default: on)
  --no-keep-at-rules   Drop @keyframes/@font-face/@import
  -h, --help           Show this help

Examples:
  inline2css page.html
  inline2css site/ --naming hash --minify --css site/app.css
  inline2css page.html --merge --in-place
`;

function parseArgs(argv) {
  const opts = { naming: 'sequential', prefix: 'i2c-' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--minify':
        opts.minify = true;
        break;
      case '--merge':
        opts.merge = true;
        break;
      case '--in-place':
        opts.inPlace = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--resolve':
        (opts.resolve = opts.resolve || []).push(argv[++i]);
        break;
      case '--resolve-linked':
        opts.resolveLinked = true;
        break;
      case '--keep-at-rules':
        opts.keepAtRules = true;
        break;
      case '--no-keep-at-rules':
        opts.keepAtRules = false;
        break;
      case '--css':
        opts.css = argv[++i];
        break;
      case '--html-out':
        opts.htmlOut = argv[++i];
        break;
      case '--naming':
        opts.naming = argv[++i];
        break;
      case '--prefix':
        opts.prefix = argv[++i];
        break;
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
        positional.push(a);
    }
  }
  opts._ = positional;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts._.length === 0) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  const input = opts._[0];
  if (!fs.existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }

  const valid = ['sequential', 'hash', 'semantic'];
  if (!valid.includes(opts.naming)) {
    console.error(`Invalid --naming: ${opts.naming} (use ${valid.join(', ')})`);
    process.exit(2);
  }

  const resolveMode = (opts.resolve && opts.resolve.length) || opts.resolveLinked;
  const isDir = fs.statSync(input).isDirectory();

  if (resolveMode) {
    if (isDir) {
      console.error('Resolve mode currently supports a single HTML file, not a directory.');
      process.exit(2);
    }
    resolveFile(input, opts)
      .then((r) => {
        const verb = opts.dryRun ? 'Would write' : 'Wrote';
        console.log(
          `${verb} ${r.resolvedKept} resolved rule(s) (dropped ${r.resolvedDropped} unused) ` +
            `+ ${r.inlineRules} inline rule(s) to ${r.cssPath}`,
        );
        console.log(`${verb} cleaned HTML to ${r.htmlPath}`);
      })
      .catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      });
    return;
  }

  if (isDir) {
    const r = convertDirectory(input, opts);
    const verb = opts.dryRun ? 'Would write' : 'Wrote';
    console.log(`${verb} ${r.ruleCount} rule(s) to ${r.cssPath}`);
    console.log(`${verb} ${r.files.length} HTML file(s)`);
  } else {
    const r = convertFile(input, opts);
    const verb = opts.dryRun ? 'Would write' : 'Wrote';
    console.log(`${verb} ${r.ruleCount} rule(s) to ${r.cssPath}`);
    console.log(`${verb} cleaned HTML to ${r.htmlPath}`);
  }
}

main();

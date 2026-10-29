#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { convertFile, convertDirectory, resolveFile, resolveDirectory } = require('../src/index');
const { version } = require('../package.json');

const HELP = `inline2css ${version}: move inline HTML styles into an external stylesheet

Usage:
  inline2css <input.html|dir> [options]

Basic options:
  --css <path>            Output CSS path (default: <dir>/styles.css)
  --html-out <path>       Output HTML path (single file only)
  --naming <mode>         sequential | hash | semantic  (default: sequential)
  --prefix <str>          Class prefix (default: i2c-)
  --minify                Minify the CSS output
  --merge                 Merge into an existing stylesheet, reusing classes
                          (basic mode only)
  --in-place              Overwrite the input HTML in place
  --dry-run               Report what would happen without writing files
  --no-boost              Write plain .i2c-1 selectors. By default extracted
                          rules are written as .i2c-1:not(#\\#), which makes
                          them as strong as the inline styles they replace
                          (they beat class rules, and lose to !important)

Resolve mode (fold Bootstrap / Tailwind CSS into your stylesheet):
  --resolve <src>         Tree-shake a stylesheet (file or URL) into the output,
                          keeping only rules the HTML can use. Repeatable.
                          A <link> whose file name matches is removed.
  --resolve-linked        Also resolve every <link rel=stylesheet> in the HTML
                          (for example a Bootstrap CDN link), then drop them.
  --safelist <name>       Always keep rules for this class. Repeatable.
                          Wrap in slashes for a pattern: --safelist /^tooltip/
  --safelist-preset <p>   Keep classes a framework adds from JavaScript.
                          Available: bootstrap. Repeatable.
  --no-auto-safelist      Do not apply the bootstrap preset automatically when
                          Bootstrap JS or data-bs-* attributes are found
  --layer                 Opt-in: wrap framework CSS in
                          @layer inline2css-framework. Caveat: a layered
                          !important rule beats your own CSS's !important
                          rules, so this can change how they interact
  --keep-all-at-rules     Keep every @keyframes and @font-face, even unused ones

Other:
  -v, --version           Print the version
  -h, --help              Show this help

Examples:
  inline2css page.html
  inline2css site/ --naming hash --minify --css site/app.css
  inline2css page.html --merge --in-place
  inline2css page.html --resolve-linked
  inline2css site/ --resolve css/bootstrap.css --safelist /^carousel/
`;

const VALUE_FLAGS = {
  '--css': 'css',
  '--html-out': 'htmlOut',
  '--naming': 'naming',
  '--prefix': 'prefix',
};
const LIST_FLAGS = {
  '--resolve': 'resolve',
  '--safelist': 'safelist',
  '--safelist-preset': 'safelistPreset',
};
const BOOL_FLAGS = {
  '--minify': ['minify', true],
  '--merge': ['merge', true],
  '--in-place': ['inPlace', true],
  '--dry-run': ['dryRun', true],
  '--no-boost': ['boost', false],
  '--boost': ['boost', true], // harmless no-op alias: boosting is the default
  '--resolve-linked': ['resolveLinked', true],
  '--no-auto-safelist': ['autoSafelist', false],
  '--layer': ['layer', true],
  '--keep-all-at-rules': ['keepAllAtRules', true],
};

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { naming: 'sequential', prefix: 'i2c-' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inlineValue;
    if (a.startsWith('--') && a.includes('=')) {
      inlineValue = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && v.length > 1 && !/^\/.*\/[a-z]*$/.test(v))) {
        throw new UsageError(`Option ${a} needs a value`);
      }
      i += 1;
      return v;
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (VALUE_FLAGS[a]) opts[VALUE_FLAGS[a]] = takeValue();
    else if (LIST_FLAGS[a]) (opts[LIST_FLAGS[a]] = opts[LIST_FLAGS[a]] || []).push(takeValue());
    else if (BOOL_FLAGS[a]) {
      if (inlineValue !== undefined) throw new UsageError(`Option ${a} does not take a value`);
      const [key, val] = BOOL_FLAGS[a];
      opts[key] = val;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`Unknown option: ${a} (see inline2css --help)`);
    } else positional.push(a);
  }
  opts._ = positional;
  return opts;
}

function fail(msg, code = 1) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) fail(e.message, 2);
    throw e;
  }
  if (opts.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts._.length === 0) {
    process.stderr.write(HELP);
    fail('missing input file or directory', 1);
  }
  if (opts._.length > 1) fail(`expected one input, got ${opts._.length}: ${opts._.join(' ')}`, 2);
  const input = opts._[0];
  if (!fs.existsSync(input)) fail(`input not found: ${input}`, 1);

  const valid = ['sequential', 'hash', 'semantic'];
  if (!valid.includes(opts.naming)) {
    fail(`invalid --naming: ${opts.naming} (use ${valid.join(', ')})`, 2);
  }
  for (const p of opts.safelistPreset || []) {
    if (String(p).toLowerCase() !== 'bootstrap') fail(`unknown --safelist-preset: ${p} (available: bootstrap)`, 2);
  }

  const resolveMode = (opts.resolve && opts.resolve.length) || opts.resolveLinked;
  const isDir = fs.statSync(input).isDirectory();
  const verb = opts.dryRun ? 'Would write' : 'Wrote';

  if (!resolveMode) {
    for (const f of ['safelist', 'safelistPreset']) {
      if (opts[f]) console.error(`note: --${f === 'safelist' ? 'safelist' : 'safelist-preset'} only applies with --resolve or --resolve-linked`);
    }
  }
  if (resolveMode && opts.merge) console.error('note: --merge is ignored in resolve mode');
  if (isDir && opts.htmlOut) fail('--html-out only works with a single input file', 2);

  if (resolveMode) {
    const r = isDir ? await resolveDirectory(input, opts) : await resolveFile(input, opts);
    const atNote = r.atRulesDropped ? `, ${r.atRulesDropped} unused @keyframes/@font-face` : '';
    console.log(
      `${verb} ${r.resolvedKept} resolved rule(s) (dropped ${r.resolvedDropped} unused${atNote}) ` +
        `+ ${r.inlineRules} inline rule(s) to ${r.cssPath}`,
    );
    if (isDir) console.log(`${verb} ${r.files.length} HTML file(s)`);
    else console.log(`${verb} cleaned HTML to ${r.htmlPath}`);
    return;
  }

  if (isDir) {
    const r = convertDirectory(input, opts);
    console.log(`${verb} ${r.ruleCount} rule(s) to ${r.cssPath}`);
    console.log(`${verb} ${r.files.length} HTML file(s)`);
  } else {
    const r = convertFile(input, opts);
    console.log(`${verb} ${r.ruleCount} rule(s) to ${r.cssPath}`);
    console.log(`${verb} cleaned HTML to ${r.htmlPath}`);
  }
}

main().catch((e) => fail(e.message, 1));

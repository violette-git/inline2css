# inline2css

**Clean up messy HTML by moving all the styling out of your page and into one tidy CSS file, automatically.**

---

## What is this? (plain English)

When you build a web page, you often end up with styling written directly on the elements, like this:

```html
<p style="color: red; font-size: 18px;">Hello</p>
```

That `style="..."` part is called an **inline style**. A few of them are fine, but when a page has hundreds, it becomes hard to read, hard to change, and hard to reuse.

**inline2css does the cleanup for you.** You give it your HTML file, and it hands back:

1. A clean HTML file with the `style="..."` clutter removed.
2. A `styles.css` file that holds all that styling in one organized place.

Your page still looks exactly the same in the browser. It's just tidier underneath, and now you can change your styling in one file instead of hunting through the whole page.

### Before and after

**Before** (`page.html`):

```html
<p style="color: red; font-size: 18px;">Hello</p>
```

**After** (`page.html` becomes clean):

```html
<p class="i2c-1">Hello</p>
```

**And you get a new `styles.css`:**

```css
.i2c-1 {
    color: red;
    font-size: 18px;
}
```

Same look, much cleaner.

---

## Why would I want this?

- **Your HTML gets easier to read.** No more walls of `style="..."` on every line.
- **Change styling in one place.** Update the CSS file once instead of editing every element.
- **It's smart about repeats.** If ten paragraphs all have the same styling, they share one class instead of creating ten copies.
- **It keeps what you already had.** If an element already has a class, inline2css adds to it, it doesn't erase it.
- **It can even absorb Bootstrap or Tailwind.** (See "Using Bootstrap or Tailwind" below.)

---

## Getting started (step by step)

### Step 1: Install it

You need [Node.js](https://nodejs.org) installed first (it's a free download). Then open your terminal (the Command Prompt on Windows, or Terminal on Mac) and type:

```
npm install -g inline2css
```

The `-g` means "install it everywhere on my computer so I can use it anytime."

### Step 2: Point it at your file

In the same terminal, go to the folder with your HTML file and type:

```
inline2css page.html
```

Replace `page.html` with the name of your actual file.

### Step 3: You're done

You'll see two new things in your folder:

- `page.cleaned.html`: your tidied-up page.
- `styles.css`: all the styling, neatly collected.

Open `page.cleaned.html` in your browser to confirm it looks the same. That's it!

> **Tip:** inline2css never overwrites your original file unless you specifically ask it to. Your `page.html` stays untouched, and the cleaned version is saved as `page.cleaned.html`. So it's safe to try.

---

## Common things you might want to do

Here are copy-paste commands for the most common tasks. Just swap in your own file names.

**Clean up a single page:**

```
inline2css page.html
```

**Clean up every page in a folder at once** (great for whole websites):

```
inline2css my-website-folder
```

**Choose where the CSS file goes:**

```
inline2css page.html --css styles/main.css
```

**Make a smaller, compressed CSS file** (good for a live website, loads faster):

```
inline2css page.html --minify
```

**Preview what would happen without changing anything** (a safe "test run"):

```
inline2css page.html --dry-run
```

**Replace the original file directly** (only do this if you've backed it up or use version control):

```
inline2css page.html --in-place
```

---

## Using Bootstrap or Tailwind

If your page uses a CSS framework like Bootstrap or Tailwind, inline2css can also **fold the parts of the framework you actually use into your own `styles.css`**, so you no longer need to load the whole framework. This is called **resolve mode**.

**If your page links to the framework already** (for example a Bootstrap `<link>` in the `<head>`):

```
inline2css page.html --resolve-linked
```

**If you have the framework's CSS file on your computer:**

```
inline2css page.html --resolve bootstrap.css
```

**For a whole website folder** (every page shares one stylesheet):

```
inline2css my-website-folder --resolve-linked
```

What happens:

- Only the framework rules your pages use are kept. A full Bootstrap file is about 280 KB; a typical page needs a small fraction of that.
- The old framework `<link>` is removed and replaced with one link to your new stylesheet.
- Your inline styles still win over the framework, just like they did when they were inline (see "Why your styles still win" below).
- Animations and web fonts nobody uses are removed too.
- Image and font paths inside the framework CSS are fixed up so they still work from the new file's location.

**Classes added by JavaScript.** Some frameworks add classes while the page runs (Bootstrap adds `show` when a menu opens, for example). Those classes are not in your HTML file, so inline2css cannot see them. If inline2css spots Bootstrap's JavaScript or any `data-bs-` attribute on your page, it keeps those classes automatically and prints one note saying so. You can also keep classes yourself:

```
inline2css page.html --resolve-linked --safelist my-class --safelist /^carousel/
```

A name wrapped in slashes, like `/^carousel/`, is a pattern: it keeps every class that starts with `carousel`.

**Keeping the framework linked instead?** If you only want to move your inline styles out (basic mode) but still load Bootstrap or Tailwind normally, add `--boost` so your moved styles keep beating the framework:

```
inline2css page.html --boost
```

**Tailwind users:** point `--resolve` at your *built* Tailwind CSS file (the one Tailwind generates), not the Tailwind CDN script.

---

## Frequently asked questions

**Will my website look different afterward?**
No. The styling is identical, it just lives in a different place. If you also use Bootstrap or Tailwind, see "Using Bootstrap or Tailwind" above (resolve mode handles this for you, and `--boost` covers the case where you keep the framework linked). The "Notes on the cascade" section further down has the details.

**Do I need to know how to code?**
No. If you can type a file name into a terminal, you can use the basic features. The commands above are all you need.

**What if my file already uses CSS classes?**
inline2css leaves them alone and simply adds its own alongside them. Nothing you already wrote gets deleted.

**What are those `i2c-1`, `i2c-2` names?**
Those are the class names inline2css creates to connect your HTML to the new CSS file. `i2c` just stands for "inline to css." You can change the style of these names (see naming strategies below) if you like, but the defaults work fine.

**Can I undo it?**
inline2css writes to *new* files by default, so your original is still there. If you used `--in-place`, you'd rely on your own backup or version control (like Git) to undo.

**Is it free?**
Yes, it's open source under the MIT license.

---

## Need something more advanced?

Everything below is for people comfortable with the command line and CSS. If the basics above cover you, you can stop reading here.

---

# Technical reference

Extract inline HTML `style` attributes into an external stylesheet, then strip the inline styles from the markup. Optionally tree-shake framework CSS (Bootstrap, Tailwind) into the same stylesheet. Available as both an **npm** package and a **PyPI** package, each usable as a CLI and as a library.

## What it does

1. Collects every element carrying a `style` attribute.
2. Deduplicates identical styles so repeated inline styles share one class.
3. Appends generated classes to existing `class` values (existing classes preserved).
4. Writes a stylesheet and injects a `<link>` into `<head>`.
5. Removes the inline `style` attributes from the output HTML.

## Features

- **Naming strategies**: `sequential` (`i2c-1`), `hash` (`i2c-a1b2c3`, content-addressed and stable), or `semantic` (`i2c-color-blue-0c59`).
- **Directory mode**: process a whole site into one shared, deduplicated stylesheet.
- **Merge mode**: reuse classes from an existing stylesheet instead of emitting duplicates.
- **Minify**: compact single-line CSS output.
- **Dry run**: report what would change without writing files.
- **In-place**: overwrite the source HTML.
- **Robust parsing**: tolerates missing semicolons, extra whitespace, quoted values, and semicolons inside `url(...)`.
- **Boost**: `--boost` raises extracted selectors by one id of specificity, for pages that keep a framework linked.
- **Resolve mode**: tree-shake Bootstrap / Tailwind / any stylesheet down to the rules the HTML can use, for one file or a whole directory, with safelists, cascade layering, dead `@keyframes` / `@font-face` pruning and `url()` rewriting.

## Install

Node:

```
npm install -g inline2css
```

Python:

```
pip install inline2css
```

## CLI

```
inline2css <input.html|dir> [options]

Basic options:
  --css <path>            Output CSS path (default: <dir>/styles.css)
  --html-out <path>       Output HTML path (single file only)
  --naming <mode>         sequential | hash | semantic  (default: sequential)
  --prefix <str>          Class prefix (default: i2c-)
  --minify                Minify CSS output
  --merge                 Reuse classes from an existing stylesheet (basic mode only)
  --in-place              Overwrite the input HTML
  --dry-run               Report without writing
  --boost                 Emit extracted selectors as .i2c-1:not(#\#)

Resolve mode:
  --resolve <src>         Tree-shake a stylesheet (file or URL). Repeatable.
  --resolve-linked        Also resolve every <link rel=stylesheet> in the HTML
  --safelist <name>       Always keep this class; /regex/ for a pattern. Repeatable.
  --safelist-preset <p>   Keep a framework's runtime classes (bootstrap). Repeatable.
  --no-auto-safelist      Do not auto-apply the bootstrap preset
  --no-layer              Do not wrap framework CSS in @layer inline2css-framework
  --keep-all-at-rules     Keep unreferenced @keyframes and @font-face

Other:
  -v, --version           Print the version
  -h, --help              Show help
```

Unknown flags exit with code 2 and a message; a missing input exits with code 1. Value flags also accept `--flag=value`.

Examples:

```
inline2css page.html
inline2css site/ --naming hash --minify --css site/app.css
inline2css page.html --merge --in-place
inline2css page.html --resolve-linked
inline2css site/ --resolve vendor/bootstrap.css --css site/assets/app.css --safelist /^carousel/
```

## Library

Node:

```js
const { convert, convertFile, convertDirectory } = require('inline2css');

const { html, rules } = convert('<p style="color:red">x</p>', { naming: 'hash' });
convertFile('page.html', { minify: true });
convertDirectory('site/', { naming: 'semantic', boost: true });
```

`convert`, `convertFile` and `convertDirectory` are synchronous. The resolve functions (`resolveFile`, `resolveDirectory`) return Promises; see Resolve mode below.

Python:

```python
from inline2css import convert, convert_file, convert_directory

html, rules = convert('<p style="color:red">x</p>', naming="hash")
convert_file("page.html", minify=True)
convert_directory("site/", naming="semantic")
```

## Notes on the cascade

An inline `style` attribute beats every normal (non-`!important`) rule in a stylesheet. A class does not: once moved into `.i2c-1` (specificity 0,1,0), the declaration loses to any competing rule with higher specificity, such as Bootstrap's `.navbar-nav .nav-link` (0,2,0). On a real Bootstrap page this shifted a nav link's padding. inline2css offers two fixes:

- **Resolve mode (automatic, default on).** The resolved framework CSS is wrapped in `@layer inline2css-framework { ... }` and the extracted rules are written after it, outside any layer. Per the CSS cascade, unlayered normal declarations beat layered normal declarations regardless of specificity, which is exactly how inline styles behaved. Framework `!important` declarations still beat your normal ones, also exactly as before. Extracted declarations that were themselves `!important` are put in a layer `inline2css-important` declared before the framework layer; for `!important` the earlier layer wins, so they still beat framework `!important`. Pass `--no-layer` to turn layering off. Cascade layers are supported by all current browsers (Chrome/Edge 99+, Firefox 97+, Safari 15.4+).
- **Basic mode, framework still linked (`--boost`, opt-in).** Extracted selectors are written as `.i2c-1:not(#\#)`. `#\#` is an id no element has, so `:not(#\#)` always matches but adds one id of specificity (1,1,0), enough to beat typical framework class chains. It cannot beat framework `!important` or id-heavy selectors.

Without either, review a visual diff on real pages.

## Tests

Node: `npm test`  ·  Python: `python tests/test_core.py` (or `pytest`)

## License

MIT

## Resolve mode: fold framework CSS (Tailwind / Bootstrap) into your stylesheet

Resolve mode reads one or more source stylesheets, keeps only the rules your HTML can use, and writes them into `styles.css` together with the extracted inline styles. Framework classes stay on the elements as hooks, but their definitions now live in your own file, so you can drop the Bootstrap/Tailwind dependency.

```
inline2css page.html --resolve framework.css
inline2css page.html --resolve https://cdn.example.com/bootstrap.min.css
inline2css page.html --resolve-linked        # resolve <link> sheets already in the HTML
inline2css page.html --resolve tailwind.out.css --minify
inline2css site/ --resolve-linked            # whole directory, one shared stylesheet
```

Sources can be local files, `http(s)` URLs (fetched with Node's global `fetch`, so Node 18 or newer), or `<link rel=stylesheet>` hrefs in the HTML (`--resolve-linked`, protocol-relative `//cdn...` hrefs are fetched over https). Explicit `--resolve` paths resolve relative to the current directory; linked hrefs resolve relative to the HTML file.

### Selector matching

A rule is kept when its selector *could* match, given the pool of classes (classes in the HTML plus the safelist). Classes are unescaped first (`.md\:flex` matches `md:flex`, `.p-\[13px\]` matches `p-[13px]`, hex escapes like `\3A ` too).

- Every top-level class in every compound is required: `.card > .title` needs both `card` and `title`.
- `:not(...)`: classes inside are ignored, never required. Bootstrap's `:not(.btn-check) + .btn:active` is kept when `btn` is used.
- `:is()`, `:where()`, `:matches()`, `:-webkit-any()`, `:-moz-any()`, `:has()`: satisfied when any selector in the argument list is satisfiable (checked recursively). Tailwind v4's `:where(.space-y-2 > :not(:last-child))` is kept when `space-y-2` is used.
- Other functional pseudos (`:nth-child(2n of .x)`, `:host(.x)`, `::slotted(.x)`, `::part()`): classes inside are ignored (conservative).
- Selectors with no class requirement at all (`body`, `:root`, `*`, `a:hover`, `[hidden]`) are kept.
- In a selector list, only the satisfiable selectors are kept; the rule is dropped when none remain.
- `@media`, `@supports` and `@layer` blocks are kept, pruned inside, and dropped when empty (an emptied named `@layer x { }` becomes `@layer x;` so layer order is preserved). Selectors inside `@keyframes` (`from`, `50%`) are never pruned.

### Safelist and presets

Classes added at runtime by JavaScript never appear in the static HTML. Add them to the pool:

- `--safelist <name>` (repeatable). A value wrapped in slashes is a JavaScript regular expression, optionally with flags: `--safelist /^tooltip/`, `--safelist /^Modal/i`.
- `--safelist-preset bootstrap` adds the classes Bootstrap 5 JS toggles: `show`, `showing`, `hiding`, `collapse`, `collapsing`, `collapse-horizontal`, `fade`, `active`, `disabled`, `open`, `modal-open`, `modal-backdrop`, `modal-static`, `offcanvas-backdrop`, `is-valid`, `is-invalid`, `was-validated`, `tooltip`, `tooltip-inner`, `tooltip-arrow`, `popover`, `popover-arrow`, `popover-header`, `popover-body`, `carousel-item-next`, `carousel-item-prev`, `carousel-item-start`, `carousel-item-end`, `dropdown-menu-end`, `toast`, plus the patterns `/^bs-tooltip-/` and `/^bs-popover-/`.
- **Auto-detect:** when a page has a `<script src>` matching `/bootstrap(\.bundle)?(\.min)?\.js/i` or any `data-bs-*` attribute, the bootstrap preset is applied automatically and one `note:` line is printed to stderr. `--no-auto-safelist` disables this. In directory mode, any one page triggering it applies the preset to the shared stylesheet.

### Layering and output order

The combined stylesheet is written in this order:

1. Hoisted `@import` rules, rewritten as `@import url(x) layer(inline2css-framework) <media>;` (an existing `layer(name)` becomes `layer(inline2css-framework.name)`), then hoisted `@namespace` rules. `@charset` is dropped (the output is UTF-8).
2. The framework CSS inside `@layer inline2css-framework { ... }`.
3. The extracted inline rules, unlayered (and, only when some inline declarations were `!important`, an `@layer inline2css-important { ... }` block declared ahead of the framework layer).

See "Notes on the cascade" above for why. `--no-layer` writes steps 1 and 2 without the layer wrapper (imports and namespaces are still hoisted, because CSS requires them first).

### Dead at-rule pruning

After tree-shaking, `@keyframes NAME` is dropped unless `NAME` appears in an `animation` or `animation-name` value somewhere in the final CSS (framework rules and extracted inline rules). `@font-face` is dropped unless its `font-family` name appears in a `font` or `font-family` value. `var(--x)` references are followed through custom property definitions, so Bootstrap's `--bs-spinner-animation-name` and Tailwind's `--animate-pulse` work. `--keep-all-at-rules` keeps every `@keyframes` and `@font-face`. (This replaces the 1.0 flags `--keep-at-rules` / `--no-keep-at-rules`, which were removed.)

### url() rewriting

- **Local source in another directory than the output CSS:** relative `url()` values (and `@import "file.css"` targets) are rewritten so they point at the same file from the output CSS location: `vendor/css/bootstrap.css` with `url(../fonts/x.woff2)` written to `styles.css` becomes `url(vendor/fonts/x.woff2)`. Query strings and fragments are kept.
- **`http(s)` source:** relative urls are made absolute against the source URL.
- Never touched: `data:`, `http(s):` and other schemes, protocol-relative `//host/...`, root-absolute `/path`, and `#fragment` urls.

### Link handling

In resolve mode, each `<link rel=stylesheet>` that was folded in is removed: all of them with `--resolve-linked`, plus any whose href basename (query string stripped) equals the basename of an explicit `--resolve` source, so `--resolve vendor/bootstrap.min.css` also removes `<link href="https://cdn.../bootstrap.min.css?v=5">`. Then exactly one `<link>` to the output CSS is added to `<head>`.

### Directory mode

Give a directory instead of a file and resolve mode processes every `.html` / `.htm` file under it (skipping `node_modules`, dot-directories, and `*.cleaned.html` outputs from a previous run):

- the class pool is the union of classes across all pages plus the safelist,
- one shared output CSS (default `<dir>/styles.css`),
- inline styles deduplicated across pages through one shared registry,
- each page gets its own relative href to the CSS (`docs/a.html` gets `../styles.css`) and its own framework link removal.

### Library

```js
const {
  resolveFile, resolveDirectory, resolveStylesheet, collectUsedClasses, selectorIsUsed,
} = require('inline2css');

await resolveFile('page.html', { resolve: ['framework.css'], minify: true });
await resolveDirectory('site/', {
  resolveLinked: true,
  safelist: ['my-class', /^carousel/],
  safelistPreset: 'bootstrap',
  autoSafelist: true,   // default
  layer: true,          // default; false = --no-layer
  boost: false,         // default
  keepAllAtRules: false // default
});

// Pure, synchronous tree-shake of CSS text (no I/O):
const { css, keptRules, droppedRules, droppedAtRules } =
  resolveStylesheet(cssText, collectUsedClasses($), { safelist: [/^tooltip/], layer: true });
```

`resolveFile` resolves to `{ cssPath, htmlPath, inlineRules, resolvedKept, resolvedDropped, atRulesDropped, autoSafelist, wrote }`; `resolveDirectory` returns the same with `files: [{ htmlPath }]` instead of `htmlPath`. Notes (like the auto-detect line) go to stderr; pass `log: false` to silence them or `log: (msg) => ...` to capture them. `selectorIsUsed(selectorAst, pool)` takes a css-tree selector node and a `Set` (or any object with `has(name)`).

### Caveats

- **Tailwind needs your compiled CSS.** A Tailwind project's real CSS is generated from your config, so point `--resolve` at your built `output.css`, not the CDN script. Bootstrap from a CDN works directly.
- **Classes built by your own JavaScript** need `--safelist`; inline2css only sees the static HTML.
- `--merge` applies to basic mode only.
- Review a visual diff on complex pages.

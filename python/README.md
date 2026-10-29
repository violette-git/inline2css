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
.i2c-1:not(#\#) {
    color: red;
    font-size: 18px;
}
```

Same look, much cleaner. The extra `:not(#\#)` is a harmless trick that makes the rule as strong as the inline style it replaced; use `--no-boost` for plain class names (`.i2c-1`).

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

You need [Python](https://www.python.org/downloads/) 3.8 or newer installed first (it's a free download). Then open your terminal (the Command Prompt on Windows, or Terminal on Mac) and type:

```
pip install inline2css
```

This installs the `inline2css` command so you can use it from any folder. (Prefer JavaScript? The same tool is on npm: `npm install -g inline2css`.)

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

**Write plain class names** (`.i2c-1` instead of `.i2c-1:not(#\#)`):

```
inline2css page.html --no-boost
```

**Check which version you have:**

```
inline2css --version
```

---

## Using Bootstrap or Tailwind

Bootstrap and Tailwind are **CSS frameworks**: big ready-made stylesheets full of classes like `btn` or `text-center` that you put on your elements. The catch is that the framework file contains thousands of rules, and a typical page uses only a few hundred of them.

inline2css can **fold the framework into your own `styles.css`**, keeping only the rules your page really uses. This is called **resolve mode**. When it's done:

- Your `styles.css` holds just the framework rules you need *plus* your inline styles (in that order).
- The `<link>` to the big framework file is removed from your page, and one `<link>` to `styles.css` is put in exactly the same spot. That matters: any CSS of your own that came after the framework still comes after it, so it still wins the same way it did before.
- Your page looks the same as before, but loads one small file instead of a huge one.

**If your page already links to the framework** (the most common case), just add `--resolve-linked`:

```
inline2css page.html --resolve-linked
```

**If you want to name the framework file yourself** (a file on your computer or a web address):

```
inline2css page.html --resolve bootstrap.min.css
inline2css page.html --resolve https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css
```

**Do a whole website folder at once** (one shared `styles.css` for every page):

```
inline2css my-website-folder --resolve-linked
```

### Things that "just work"

- **Your inline styles still win.** On the original page an inline `style="..."` beats normal framework rules. The `:not(#\#)` trick (see "Before and after") gives your extracted styles the extra strength they need to keep winning.
- **Your own CSS keeps working.** inline2css leaves the framework rules exactly as they were, in the same place in the page, so the rules in your own `<style>` blocks and stylesheets interact with them just like before (including `!important` rules).
- **Bootstrap's JavaScript pieces keep working.** Menus, modals, tooltips and similar parts add classes like `show` while the page is running, so they're not in your HTML file. If inline2css sees that your page uses Bootstrap's JavaScript, it keeps those classes automatically and prints a short note telling you so.
- **Screen-size rules, hover effects and animations** your page uses are kept. Animations and fonts nothing uses are dropped to save space.
- **Images and fonts referenced by the framework** still load, because inline2css fixes their paths for the new file location.

### When you need to help it

Some classes are added only by JavaScript (yours or a plugin's), so inline2css can't see them in the HTML. Tell it to keep them with `--safelist`:

```
inline2css page.html --resolve-linked --safelist is-open --safelist /^toast-/
```

A name wrapped in slashes, like `/^toast-/`, is a pattern: here it means "every class that starts with `toast-`".

**Advanced option, `--layer`:** this puts the framework rules in a separate lower-priority group (a CSS "layer"). It is off by default because it has a catch: it flips how `!important` rules work, so the framework's `!important` rules start beating your own `!important` rules. Only use it if you know you want that (see "Precedence" in the technical reference).

**Tailwind tip:** point inline2css at the CSS file Tailwind *built* for your project (for example `output.css`), not the Tailwind CDN script. The built file is the real stylesheet.

**Keeping the framework linked separately instead?** Just run the basic command (`inline2css page.html`). Your extracted styles still beat the framework's normal class rules, thanks to the same `:not(#\#)` trick.

**If you see a `warn:` line** about the cascade order: your page had some other CSS (a `<style>` block or another stylesheet) sitting *between* two framework links. All the folded framework CSS now sits where the first link was, so that in-between CSS now comes after all of it. Usually harmless, but compare the page in your browser.

---

## Frequently asked questions

**Will my website look different afterward?**
No. The styling is identical, it just lives in a different place. inline2css also takes care of keeping your inline styles in charge (see "Before and after"). If anything ever looks off on a very complex page, see the "Notes on the cascade" section further down.

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

Extract inline HTML `style` attributes into an external stylesheet, then strip the inline styles from the markup. Optionally tree-shake framework stylesheets into the same file. Available as both an **npm** package and a **PyPI** package, each usable as a CLI and as a library. This is the Python package (`tinycss2` for CSS parsing, `beautifulsoup4` for HTML).

## What it does

1. Collects every element carrying a `style` attribute.
2. Deduplicates identical styles so repeated inline styles share one class.
3. Appends generated classes to existing `class` values (existing classes preserved).
4. Writes a stylesheet (selectors boosted to `.i2c-1:not(#\#)` by default) and injects a `<link>` into `<head>`.
5. Removes the inline `style` attributes from the output HTML.
6. In resolve mode, also tree-shakes source stylesheets down to the rules the HTML can match (left unlayered, in source order) and replaces the folded-in `<link>` tags with one link to the output, at the position of the first one.

## Features

- **Naming strategies**: `sequential` (`i2c-1`), `hash` (`i2c-` + first 6 hex of sha1 of the canonical declaration key, stable), or `semantic` (`i2c-<slug of first prop-value, max 40>-` + 4 hex of sha1, e.g. `i2c-color-blue-0c59`).
- **Directory mode**: process a whole site into one shared, deduplicated stylesheet (skips `node_modules` and dot-directories).
- **Merge mode**: reuse classes from an existing stylesheet instead of emitting duplicates.
- **Minify**: compact single-line CSS output.
- **Dry run**: report what would change without writing files.
- **In-place**: overwrite the source HTML.
- **Robust parsing**: tolerates missing semicolons, extra whitespace, quoted values, and semicolons inside `url(...)` or quotes. Duplicate properties are last-wins; dedup uses a canonical (sorted) key.
- **Resolve mode**: framework tree-shaking with correct selector matching, safelists, cascade-preserving link placement, specificity boost, optional cascade layers, dead `@keyframes` / `@font-face` pruning, `url()` rewriting, and directory support.

## Install

Python:

```
pip install inline2css
```

Node:

```
npm install -g inline2css
```

## CLI

```
inline2css <input.html|dir> [options]

output:
  --css PATH              Output CSS path (default: <input dir>/styles.css)
  --html-out PATH         Output HTML path (single file only; default: <name>.cleaned.html)
  --in-place              Overwrite the input HTML
  --dry-run               Report what would happen without writing files
  --minify                Minify the CSS output
  --merge                 Reuse classes from an existing output stylesheet

inline extraction:
  --naming MODE           sequential | hash | semantic (default: sequential)
  --prefix STR            Class prefix (default: i2c-)
  --no-boost              Write plain .i2c-1 selectors (default: .i2c-1:not(#\#))

resolve mode:
  --resolve SRC           Tree-shake a stylesheet (path or http(s) URL). Repeatable.
  --resolve-linked        Also resolve every <link rel=stylesheet> in the HTML
  --safelist NAME         Always keep this class; /regex/ for a pattern. Repeatable.
  --safelist-preset NAME  Add a preset safelist (bootstrap). Repeatable.
  --no-auto-safelist      Disable Bootstrap auto-detection
  --layer                 Opt-in: wrap framework CSS in @layer inline2css-framework
  --keep-all-at-rules     Keep every @keyframes and @font-face

  -v, --version           Print the version number (e.g. 1.1.1) and exit
  -h, --help              Show help and exit
```

`--boost` is still accepted as a no-op (boost is the default). Notes and warnings go to stderr; `--safelist` / `--safelist-preset` without resolve mode print a note that they have no effect. HTML is re-serialized with whitespace, attribute order and `&nbsp;` preserved; other entities are written as their characters (UTF-8).

Exit codes: `0` success, `1` missing input or a resolve source that cannot be loaded, `2` unknown flag or bad flag value (the message names the unknown flag).

Examples:

```
inline2css page.html
inline2css site/ --naming hash --minify --css site/app.css
inline2css page.html --merge --in-place
inline2css page.html --resolve-linked
inline2css page.html --resolve-linked --layer
inline2css page.html --no-boost
inline2css page.html --resolve vendor/bootstrap.min.css --safelist /^tooltip/ --css dist/app.css
inline2css site/ --resolve https://cdn.example.com/bootstrap.min.css --minify
```

## Resolve mode in detail

Resolve mode is on when `--resolve` or `--resolve-linked` is given.

### Sources

- `--resolve SRC`: a file path (relative to the current directory) or an `http(s)://` URL (fetched with `urllib`). Repeatable; each distinct source is loaded once, in order.
- `--resolve-linked`: every `<link rel="stylesheet" href>` in the page (hrefs relative to the HTML file, or absolute URLs). A linked sheet that fails to load prints a warning and is left linked; a `--resolve` source that fails to load is an error (exit 1).

### Selector matching

A selector is kept when it *could* match given the pool of classes found on the page (after inline extraction) plus the safelist:

- Every top-level class in each compound selector is required (`.card .title` needs both).
- Classes inside `:not(...)` are ignored. Bootstrap's `:not(.btn-check)+.btn:active` is kept when `.btn` is used.
- `:is()`, `:where()`, `:matches()`, `:-webkit-any()`, `:-moz-any()` and `:has()` are satisfied when any selector in their argument list is (recursive). Tailwind v4's `:where(.space-y-2 > :not(:last-child))` is kept when `space-y-2` is used.
- Other functional pseudos (`:nth-child(2n of .x)`, `:host(.x)`, `::part()`, `::slotted(.x)`) are treated conservatively: classes inside are ignored.
- Selectors with no class requirement (`body`, `:root`, `*`, `a:hover`, `[hidden]`) are kept.
- CSS identifiers are unescaped before matching: `.md\:flex` matches `md:flex`, `.p-\[13px\]` matches `p-[13px]`, `.\31 0` matches `10`.
- In a selector list only the satisfiable selectors are kept; a rule with none left is dropped.
- `@media`, `@supports`, `@layer`, `@container`, `@scope`, `@starting-style` and CSS-nested rules are walked recursively. Now-empty blocks are dropped (an empty named `@layer x { }` becomes the statement `@layer x;` so layer order is unchanged). `@property`, `@page`, `@counter-style` and similar are kept as-is. `/*! ... */` license comments are kept.

### Safelist

- `--safelist NAME` adds a class to the pool. A value wrapped in slashes is a regex: `--safelist /^tooltip/` (flags allowed: `/x/i`).
- `--safelist-preset bootstrap` adds the classes Bootstrap's JavaScript adds at runtime: `show`, `showing`, `hiding`, `collapse`, `collapsing`, `collapse-horizontal`, `fade`, `active`, `disabled`, `open`, `modal-open`, `modal-backdrop`, `modal-static`, `offcanvas-backdrop`, `is-valid`, `is-invalid`, `was-validated`, `tooltip`, `tooltip-inner`, `tooltip-arrow`, `popover`, `popover-arrow`, `popover-header`, `popover-body`, `carousel-item-next`, `carousel-item-prev`, `carousel-item-start`, `carousel-item-end`, `dropdown-menu-end`, `toast`, and the patterns `/^bs-tooltip-/`, `/^bs-popover-/`.
- Auto-detect: when a page has a `<script src>` matching `/bootstrap(\.bundle)?(\.min)?\.js/i` or any `data-bs-*` attribute, the bootstrap preset is applied and one `note:` line is printed to stderr. `--no-auto-safelist` turns this off.

### Precedence

A real inline style (specificity 1,0,0,0) beats every normal author rule; a class (0,1,0) does not. Two things keep the cascade the same as on the original page:

1. **Boost (default on, both modes).** Extracted rules are written as `.i2c-1:not(#\#)`. `:not(#\#)` matches every element (no element has the id `#`) and adds one id of specificity, so the rule is (1,1,0): it beats class-only framework and page rules the way the inline style did, and still loses to any `!important` rule, also like the inline style. Inline declarations that carry `!important` stay in the same boosted rule; an important (1,1,0) beats class-only important rules such as Bootstrap's `.d-none { display: none !important }`, matching inline-important semantics. The class names in the HTML are unchanged (`class="i2c-1"`). `--no-boost` writes plain `.i2c-1`. `--merge` reads both forms.
2. **Link position (resolve mode).** The framework rules are emitted unlayered, in their original source order, and the single output `<link>` takes the place of the first removed framework `<link>` (same parent, same position). A page `<style>` block or stylesheet that came after the framework still comes after it, so the page's own rules (including its `!important` ones) keep beating the framework exactly as before. When no link was removed (an explicit `--resolve` of a sheet the page never linked), the output link is appended to the end of `<head>`. When the removed links were not contiguous (a `<style>` or a kept stylesheet `<link>` sat between them), one `warn:` line is printed, because that in-between CSS now follows all of the folded CSS.

Without `--layer`, `@charset` is dropped and `@import` / `@namespace` rules are hoisted to the top of the output file unchanged.

Boost is not a perfect copy of inline precedence: a normal page rule with an id plus a class or more, (1,1,1) and up, would have lost to the inline style but beats the boosted class. Such selectors are rare next to inline styles; check a visual diff if your page uses them.

#### Opt-in: `--layer`

`--layer` wraps the resolved framework CSS in `@layer inline2css-framework { ... }` and emits the extracted inline rules after it, unlayered. Unlayered normal rules beat layered normal rules regardless of specificity, so this restores inline precedence over the framework even without boost.

**Caveat:** for `!important` declarations the cascade reverses: a layered `!important` beats every unlayered `!important`. So with `--layer`, a framework `!important` rule (for example `.d-none { display: none !important }`) now beats your page's own unlayered `!important` overrides, which changes how the framework interacts with your CSS. That is why it is not the default. While wrapping:

- `@charset` is dropped.
- `@import url(x) media;` is moved to the very top as `@import url("x") layer(inline2css-framework) media;` (an existing `layer(name)` becomes `layer(inline2css-framework.name)`).
- `@namespace` is moved to the top, after the imports.
- When any extracted inline style uses `!important`, those declarations go into `@layer inline2css-important { ... }` at the end of the file, and the file starts with `@layer inline2css-important,inline2css-framework;` so the important layer is ordered first (for important declarations the earlier layer wins). The rest of that inline style stays unlayered. Example (with `--layer --no-boost`):

```css
@layer inline2css-important,inline2css-framework;
@layer inline2css-framework {
    .a {
        color: blue !important;
    }
}

.i2c-1 {
    padding: 2px;
}

@layer inline2css-important {
    .i2c-1 {
        color: red !important;
    }
}
```

### Dead at-rule pruning

After tree-shaking, `@keyframes NAME` is dropped unless `NAME` appears in an `animation` / `animation-name` value anywhere in the final CSS, including extracted inline styles. `@font-face` is dropped unless its `font-family` name appears in a `font` / `font-family` value. `var(--x)` references are followed through custom properties (recursively), which covers Tailwind's `animation: var(--animate-pulse)`; a custom property nothing uses through `var()` does not count. `--keep-all-at-rules` keeps them all.

### url() rewriting

- Local source in a different directory from the output CSS: relative `url()` values (and `image-set()` strings) are rewritten so they point at the same file from the output location. `data:`, `http(s):`, `//`, `/absolute` and `#fragment` urls are left alone.
- `http(s)` source: relative urls are made absolute against the source URL.

### Link handling

Each `<link rel=stylesheet>` that was folded in is removed: all successfully loaded ones for `--resolve-linked`, plus any whose href basename (query string stripped) equals the basename of an explicit `--resolve` source. One `<link>` to the output CSS replaces the first removed link (same parent, same position); if none was removed it is appended to the end of `<head>`. It is never duplicated: if the page already links the output CSS, no new link is added. A `warn:` line is printed when the removed links were not contiguous (see Precedence).

### Directory input

`inline2css site/ --resolve-linked` (or `--resolve ...`) resolves a whole site: the class pool is the union across every `.html` / `.htm` file (skipping `node_modules` and dot-directories) plus the safelist, there is one shared output CSS, inline styles are deduplicated across pages with one shared registry, each page gets its own relative href to the CSS, and framework links are removed per page.

### Output order

1. Hoisted `@import` rules, then `@namespace` rules.
2. The resolved framework rules, in original source order (inside `@layer inline2css-framework` with `--layer`).
3. The extracted inline rules (with `--layer`, any inline `!important` declarations follow in `@layer inline2css-important`).

The non-minified printer works from a parsed tree, so it never puts a newline inside a string, a `url(...)` or parentheses (Bootstrap's `data:` URIs stay intact).

## Library

```python
from inline2css import (
    convert, convert_file, convert_directory,
    resolve_file, resolve_directory, resolve_stylesheet,
    collect_used_classes, selector_is_used,
)

# Inline extraction
html, rules = convert('<p style="color:red">x</p>', naming="hash")
convert_file("page.html", minify=True)
convert_directory("site/", naming="semantic")
convert_file("page.html", boost=False)           # plain .i2c-1 (default: .i2c-1:not(#\#))

# Resolve mode (same options as the CLI, snake_case)
r = resolve_file(
    "page.html",
    resolve=["vendor/bootstrap.min.css"],         # paths (relative to cwd) or URLs
    resolve_linked=True,
    safelist=["is-open", "/^toast-/"],             # strings or compiled re patterns
    safelist_preset="bootstrap",
    auto_safelist=True,
    layer=False,                                   # opt-in @layer mode
    boost=True,
    keep_all_at_rules=False,
    css="dist/app.css",
)
print(r.resolved_kept, r.resolved_dropped, r.inline_rules, r.notes)   # notes include warn: lines

resolve_directory("site/", resolve_linked=True, minify=True)

# Lower-level building blocks
used = collect_used_classes(open("page.html").read())   # set of class names
selector_is_used(":not(.btn-check)+.btn:active", used)  # True when "btn" is used
res = resolve_stylesheet(open("bootstrap.css").read(), used,
                         source="bootstrap.css", css_out="styles.css")
print(res.css, res.kept_rules, res.dropped_rules, res.pruned_at_rules)
```

`resolve_file` returns `ResolveFileResult(css_path, html_path, inline_rules, resolved_kept, resolved_dropped, pruned_at_rules, wrote, auto_safelist, sources, notes, css)`; `resolve_directory` returns the same with `html_paths`. `resolve_stylesheet` also accepts a list of `(css_text, origin)` pairs, and `inline_rules=` / `boost=` (default True) / `layer=` (default False) to append extracted rules after the framework rules.

## Notes on the cascade

Moving a `style` attribute (specificity 1,0,0,0) into a class (specificity 0,1,0) lowers specificity. The default boost (`:not(#\#)`, giving 1,1,0) restores precedence over class-based rules in both modes, and resolve mode keeps the framework at its original position so your own CSS still comes after it. Selectors with an id plus a class or more that previously lost to the inline style may now win; with `--no-boost`, any class rule that loads later or is more specific may win. Review a visual diff on real pages.

## Tests

Python: `pytest` or `python tests/test_core.py`  ·  Node: `npm test`

## License

MIT

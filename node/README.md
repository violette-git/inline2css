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
- **It can even absorb Bootstrap or Tailwind.** (More on that in the advanced section below.)

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

- `page.cleaned.html` — your tidied-up page.
- `styles.css` — all the styling, neatly collected.

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

## Frequently asked questions

**Will my website look different afterward?**
No. The styling is identical, it just lives in a different place. If anything ever looks off on a very complex page, see the "Notes on the cascade" section further down.

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

Extract inline HTML `style` attributes into an external stylesheet, then strip the inline styles from the markup. Available as both an **npm** package and a **PyPI** package, each usable as a CLI and as a library.

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

  --css <path>       Output CSS path (default: <dir>/styles.css)
  --html-out <path>  Output HTML path (single file only)
  --naming <mode>    sequential | hash | semantic  (default: sequential)
  --prefix <str>     Class prefix (default: i2c-)
  --minify           Minify CSS output
  --merge            Reuse classes from an existing stylesheet
  --in-place         Overwrite the input HTML
  --dry-run          Report without writing
```

Examples:

```
inline2css page.html
inline2css site/ --naming hash --minify --css site/app.css
inline2css page.html --merge --in-place
```

## Library

Node:

```js
const { convert, convertFile, convertDirectory } = require('inline2css');

const { html, rules } = convert('<p style="color:red">x</p>', { naming: 'hash' });
convertFile('page.html', { minify: true });
convertDirectory('site/', { naming: 'semantic' });
```

Python:

```python
from inline2css import convert, convert_file, convert_directory

html, rules = convert('<p style="color:red">x</p>', naming="hash")
convert_file("page.html", minify=True)
convert_directory("site/", naming="semantic")
```

## Notes on the cascade

Moving a `style` attribute (specificity 1,0,0,0) into a class (specificity 0,0,1,0) lowers specificity. If a page has competing selectors that previously lost to the inline style, they may now win. Review a visual diff on real pages, or keep inline styles for elements where this matters.

## Tests

Node: `npm test`  ·  Python: `python tests/test_core.py` (or `pytest`)

## License

MIT

## Resolve mode: fold framework CSS (Tailwind / Bootstrap) into your stylesheet

Resolve mode reads one or more source stylesheets, keeps only the rules your HTML actually uses, and writes them into `styles.css` alongside any extracted inline styles. Framework classes stay on the elements as hooks, but their definitions now live in your own file, so you can drop the Bootstrap/Tailwind dependency.

```
inline2css page.html --resolve framework.css
inline2css page.html --resolve https://cdn.example.com/bootstrap.min.css
inline2css page.html --resolve-linked        # resolve <link> sheets already in the HTML
inline2css page.html --resolve tailwind.out.css --minify
```

What it preserves:

- **`@media` queries** stay as media blocks; unused rules inside them are pruned.
- **Pseudo-states** (`:hover`, `:focus`, ...) stay as real selectors.
- **Descendant / combinator selectors** (`.card > .title`) are kept only when every class they reference is present in the HTML.
- **Escaped utility classes** (Tailwind `md:flex` -> `.md\:flex`, `p-[13px]` -> `.p-\[13px\]`) are unescaped before matching, so they resolve correctly.
- **Bare element selectors** (`body`, `a:hover`) are kept by default; `@keyframes` / `@font-face` are kept unless you pass `--no-keep-at-rules`.

Sources can be local files, URLs, or `<link>` hrefs in the HTML (via `--resolve-linked`). Explicit `--resolve` paths resolve relative to the current directory; linked hrefs resolve relative to the HTML file.

### Library

```js
const { resolveFile, resolveStylesheet, collectUsedClasses } = require('inline2css');

await resolveFile('page.html', { resolve: ['framework.css'], minify: true });
```

### Caveats

- **Tailwind needs your compiled CSS.** A Tailwind project's real CSS is generated from your config, so point `--resolve` at your built `output.css`, not the CDN. Bootstrap from a CDN works directly.
- **Resolve mode is single-file** for now (directory mode remains available for plain inline extraction).
- Specificity is preserved by keeping source order of kept rules; review a visual diff on complex pages.

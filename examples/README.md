# Examples

Three real-world pages, each shown before and after inline2css. Open any `.html` file in your browser to see it.

| Folder | What it shows |
| --- | --- |
| `01-plain-html` | A dashboard with 11 inline styles, some repeated, plus a small custom stylesheet with hover effects, a media query and an animation. |
| `02-bootstrap` | A real Bootstrap 5 page (navbar, cards, form, alert, table, list group) with 6 inline styles. One of them sits on a nav link where Bootstrap's own rule is stronger than a plain class, which is the tricky case. |
| `03-tailwind` | A real Tailwind 4 page, including responsive (`md:`), hover, focus, disabled, and arbitrary-value (`w-[137px]`) classes, plus 3 inline styles. |

## What is in each folder

- `original.html` is the starting page, untouched.
- The framework stylesheet it uses (`framework.css`, `bootstrap.min.css`, or `tailwind.css`).
- `output-*.html` and `output-*.css`: what inline2css produced, one pair per mode.
- `compare.html`: the original and every output rendered side by side, so you can confirm they look the same.

## Opening the comparison pages

Open `compare.html` in any folder straight from disk (double-click it, or drag it into a browser tab). No server or network connection is needed. Each page shows:

- what the example demonstrates, in plain language
- the original and every output rendered live side by side, loading the real files in that folder (switch between a 1024 px and a 390 px page width)
- inline styles before and after, the CSS bytes each page loads, and how many framework rules were kept or dropped
- one element's HTML before and after, with the CSS rule it became
- the exact command behind each output

The three pages link to each other from the top bar.

## The output files

| Folder | Output | Mode |
| --- | --- | --- |
| `01-plain-html` | `output-basic` | Default sequential class names (`.i2c-1`), `framework.css` stays linked |
| `01-plain-html` | `output-semantic` | Semantic class names, minified CSS |
| `01-plain-html` | `output-hash` | Hash-based class names |
| `01-plain-html` | `output-resolved` | `framework.css` folded in (unused rules dropped), link removed |
| `02-bootstrap` | `output-basic` | Inline styles only, `bootstrap.min.css` stays linked |
| `02-bootstrap` | `output-resolved` | Bootstrap folded in (194 rules kept, 2,356 dropped), link removed |
| `02-bootstrap` | `output-resolved-minified` | The same as resolved, minified |
| `03-tailwind` | `output-basic` | Inline styles only, `tailwind.css` stays linked |
| `03-tailwind` | `output-resolved` | Tailwind folded in (all 112 rules kept), link removed |

Every output was checked against its original in headless Chromium: computed styles match on every element, and full-page screenshots are pixel-identical at 1280 px and 390 px wide.

## Regenerate them yourself

From the repository root, after `cd node && npm install`:

```
# 01-plain-html
node node/bin/cli.js examples/01-plain-html/original.html --css examples/01-plain-html/output-basic.css --html-out examples/01-plain-html/output-basic.html
node node/bin/cli.js examples/01-plain-html/original.html --naming semantic --minify --css examples/01-plain-html/output-semantic.css --html-out examples/01-plain-html/output-semantic.html
node node/bin/cli.js examples/01-plain-html/original.html --naming hash --css examples/01-plain-html/output-hash.css --html-out examples/01-plain-html/output-hash.html
node node/bin/cli.js examples/01-plain-html/original.html --resolve-linked --css examples/01-plain-html/output-resolved.css --html-out examples/01-plain-html/output-resolved.html

# 02-bootstrap
node node/bin/cli.js examples/02-bootstrap/original.html --css examples/02-bootstrap/output-basic.css --html-out examples/02-bootstrap/output-basic.html
node node/bin/cli.js examples/02-bootstrap/original.html --resolve-linked --css examples/02-bootstrap/output-resolved.css --html-out examples/02-bootstrap/output-resolved.html
node node/bin/cli.js examples/02-bootstrap/original.html --resolve-linked --minify --css examples/02-bootstrap/output-resolved-minified.css --html-out examples/02-bootstrap/output-resolved-minified.html

# 03-tailwind
node node/bin/cli.js examples/03-tailwind/original.html --css examples/03-tailwind/output-basic.css --html-out examples/03-tailwind/output-basic.html
node node/bin/cli.js examples/03-tailwind/original.html --resolve-linked --css examples/03-tailwind/output-resolved.css --html-out examples/03-tailwind/output-resolved.html
```

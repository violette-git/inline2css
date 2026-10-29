# inline2css

**Move the styling out of your HTML and into one clean CSS file, automatically. Works with plain HTML, Bootstrap, and Tailwind.**

You give it a web page full of `style="..."` attributes (and, if you want, the Bootstrap or Tailwind stylesheet it uses). It gives you back:

1. The same page with every inline style removed.
2. One `styles.css` containing only the CSS that page actually needs.

The page looks exactly the same in the browser. The code underneath is just clean.

## Pick your version

This repository contains two packages that do the same job:

| If you use... | Install with | Docs |
| --- | --- | --- |
| Node.js / JavaScript | `npm install -g inline2css` | [node/README.md](node/README.md) |
| Python | `pip install inline2css` | [python/README.md](python/README.md) |

Both give you the same `inline2css` command and the same options, so pick whichever language you already have installed.

## Quick start

```
inline2css page.html
```

That writes `page.cleaned.html` and `styles.css` next to your file. Your original is never touched unless you add `--in-place`.

Using Bootstrap or Tailwind and want to drop the framework file entirely?

```
inline2css page.html --resolve bootstrap.min.css
```

That folds just the Bootstrap rules your page uses into `styles.css` and removes the Bootstrap `<link>` from the page.

## See it in action

Open the [examples](examples/) folder. Each example has the original page, the converted output, and a side-by-side comparison page you can open in any browser:

- `examples/01-plain-html`: a page full of inline styles, converted with every naming style.
- `examples/02-bootstrap`: a real Bootstrap 5 page, with Bootstrap folded into one small stylesheet.
- `examples/03-tailwind`: a real Tailwind 4 page, with the compiled Tailwind CSS folded in.

## Repository layout

```
node/       npm package (CLI + library)
python/     PyPI package (CLI + library)
examples/   before/after demo pages
.github/    CI that runs both test suites on every push
```

## License

MIT

"""Command-line interface for inline2css."""

from __future__ import annotations

import argparse
import os
import sys

from . import (
    __version__,
    convert_directory,
    convert_file,
    resolve_directory,
    resolve_file,
)

DESCRIPTION = """Move inline HTML styles into an external stylesheet.

Resolve mode (--resolve / --resolve-linked) also folds framework CSS such as
Bootstrap or Tailwind into the same file, keeping only the rules the HTML uses,
and removes the framework <link> tags it folded in."""

EPILOG = """examples:
  inline2css page.html
  inline2css site/ --naming hash --minify --css site/app.css
  inline2css page.html --merge --in-place
  inline2css page.html --resolve-linked
  inline2css page.html --resolve bootstrap.min.css --safelist /^tooltip/
  inline2css site/ --resolve https://cdn.example.com/bootstrap.min.css
  inline2css page.html --no-boost       (plain .i2c-1 selectors)
  inline2css page.html --resolve-linked --layer   (opt-in @layer mode)"""


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # clearer unknown-flag message, exit code 2
        if message.startswith("unrecognized arguments"):
            bad = message.split(":", 1)[1].strip()
            message = f"unknown option(s): {bad} (see inline2css --help)"
        self.print_usage(sys.stderr)
        self.exit(2, f"inline2css: error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(
        prog="inline2css",
        description=DESCRIPTION,
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    p.add_argument("input", nargs="?", help="HTML file or directory")
    p.add_argument("-v", "--version", action="version", version=__version__)

    g = p.add_argument_group("output")
    g.add_argument("--css", metavar="PATH", help="Output CSS path (default: <dir>/styles.css)")
    g.add_argument("--html-out", metavar="PATH", help="Output HTML path (single file only)")
    g.add_argument("--in-place", action="store_true", help="Overwrite the input HTML")
    g.add_argument("--dry-run", action="store_true", help="Report what would happen without writing files")
    g.add_argument("--minify", action="store_true", help="Minify the CSS output")
    g.add_argument("--merge", action="store_true", help="Reuse classes from an existing output stylesheet")

    g = p.add_argument_group("inline extraction")
    g.add_argument(
        "--naming", choices=["sequential", "hash", "semantic"], default="sequential",
        help="Class naming strategy (default: sequential)",
    )
    g.add_argument("--prefix", default="i2c-", help="Class prefix (default: i2c-)")
    g.add_argument(
        "--no-boost", dest="boost", action="store_false",
        help="Write plain .i2c-1 selectors. By default extracted rules are written as "
             ".i2c-1:not(#\\#), which adds one id of specificity so they win over class rules "
             "the way the inline styles did (any !important rule still wins, as before).",
    )
    g.add_argument("--boost", dest="boost", action="store_true", help=argparse.SUPPRESS)
    p.set_defaults(boost=True)

    g = p.add_argument_group("resolve mode")
    g.add_argument(
        "--resolve", action="append", default=[], metavar="SRC",
        help="Tree-shake a stylesheet (file path relative to the current directory, or http(s) URL) "
             "into the output CSS. Repeatable. A <link> whose href has the same basename is removed.",
    )
    g.add_argument(
        "--resolve-linked", action="store_true",
        help="Also resolve every <link rel=stylesheet> in the HTML (hrefs relative to the HTML file), "
             "then remove those links",
    )
    g.add_argument(
        "--safelist", action="append", default=[], metavar="NAME",
        help="Always keep rules for this class. A value wrapped in slashes is a regex (/^tooltip/). Repeatable.",
    )
    g.add_argument(
        "--safelist-preset", action="append", default=[], choices=["bootstrap"],
        help="Add a preset safelist (bootstrap: classes Bootstrap's JavaScript adds at runtime)",
    )
    g.add_argument(
        "--no-auto-safelist", action="store_true",
        help="Do not apply the bootstrap preset automatically when the page loads bootstrap.js "
             "or uses data-bs-* attributes",
    )
    g.add_argument(
        "--layer", action="store_true",
        help="Opt-in: wrap the resolved framework CSS in @layer inline2css-framework (and inline "
             "!important declarations in @layer inline2css-important). Caveat: a layered !important "
             "beats every unlayered !important, so this changes how framework !important rules "
             "interact with your own CSS. Default off.",
    )
    g.add_argument(
        "--keep-all-at-rules", action="store_true",
        help="Keep every @keyframes and @font-face, even ones nothing references",
    )
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.input:
        parser.print_usage(sys.stderr)
        print("inline2css: error: missing input (an HTML file or a directory)", file=sys.stderr)
        return 1
    if not os.path.exists(args.input):
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 1

    is_dir = os.path.isdir(args.input)
    if is_dir and args.html_out:
        print("inline2css: error: --html-out only works with a single HTML file", file=sys.stderr)
        return 2

    verb = "Would write" if args.dry_run else "Wrote"
    resolve_mode = bool(args.resolve) or args.resolve_linked

    if not resolve_mode:
        for flag, value in (("--safelist", args.safelist), ("--safelist-preset", args.safelist_preset)):
            if value:
                print(f"note: {flag} only applies with --resolve or --resolve-linked", file=sys.stderr)

    if resolve_mode:
        opts = dict(
            resolve=args.resolve,
            resolve_linked=args.resolve_linked,
            css=args.css,
            naming=args.naming,
            prefix=args.prefix,
            minify=args.minify,
            merge=args.merge,
            in_place=args.in_place,
            dry_run=args.dry_run,
            safelist=args.safelist,
            safelist_preset=args.safelist_preset,
            auto_safelist=not args.no_auto_safelist,
            layer=args.layer,
            boost=args.boost,
            keep_all_at_rules=args.keep_all_at_rules,
        )
        try:
            if is_dir:
                r = resolve_directory(args.input, **opts)
            else:
                r = resolve_file(args.input, html_out=args.html_out, **opts)
        except (OSError, RuntimeError, ValueError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        for note in r.notes:
            print(note, file=sys.stderr)
        pruned = f", {r.pruned_at_rules} unused @keyframes/@font-face" if r.pruned_at_rules else ""
        print(
            f"{verb} {r.resolved_kept} resolved rule(s) (dropped {r.resolved_dropped} unused{pruned}) "
            f"+ {r.inline_rules} inline rule(s) to {r.css_path}"
        )
        if is_dir:
            print(f"{verb} {len(r.html_paths)} HTML file(s)")
        else:
            print(f"{verb} cleaned HTML to {r.html_path}")
        return 0

    if is_dir:
        r = convert_directory(
            args.input, css=args.css, naming=args.naming, prefix=args.prefix,
            minify=args.minify, merge=args.merge, in_place=args.in_place,
            dry_run=args.dry_run, boost=args.boost,
        )
        print(f"{verb} {r.rule_count} rule(s) to {r.css_path}")
        print(f"{verb} {len(r.html_paths)} HTML file(s)")
    else:
        r = convert_file(
            args.input, css=args.css, html_out=args.html_out, naming=args.naming,
            prefix=args.prefix, minify=args.minify, merge=args.merge,
            in_place=args.in_place, dry_run=args.dry_run, boost=args.boost,
        )
        print(f"{verb} {r.rule_count} rule(s) to {r.css_path}")
        print(f"{verb} cleaned HTML to {r.html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

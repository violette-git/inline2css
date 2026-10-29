"""Command-line interface for inline2css."""

from __future__ import annotations

import argparse
import os
import sys

from . import convert_directory, convert_file


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="inline2css",
        description="Move inline HTML styles into an external stylesheet.",
    )
    p.add_argument("input", help="HTML file or directory")
    p.add_argument("--css", help="Output CSS path (default: <dir>/styles.css)")
    p.add_argument("--html-out", help="Output HTML path (single file only)")
    p.add_argument(
        "--naming",
        choices=["sequential", "hash", "semantic"],
        default="sequential",
        help="Class naming strategy (default: sequential)",
    )
    p.add_argument("--prefix", default="i2c-", help="Class prefix (default: i2c-)")
    p.add_argument("--minify", action="store_true", help="Minify CSS output")
    p.add_argument("--merge", action="store_true", help="Reuse an existing stylesheet")
    p.add_argument("--in-place", action="store_true", help="Overwrite input HTML")
    p.add_argument("--dry-run", action="store_true", help="Report without writing")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if not os.path.exists(args.input):
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 1

    verb = "Would write" if args.dry_run else "Wrote"

    if os.path.isdir(args.input):
        r = convert_directory(
            args.input,
            css=args.css,
            naming=args.naming,
            prefix=args.prefix,
            minify=args.minify,
            merge=args.merge,
            in_place=args.in_place,
            dry_run=args.dry_run,
        )
        print(f"{verb} {r.rule_count} rule(s) to {r.css_path}")
        print(f"{verb} {len(r.html_paths)} HTML file(s)")
    else:
        r = convert_file(
            args.input,
            css=args.css,
            html_out=args.html_out,
            naming=args.naming,
            prefix=args.prefix,
            minify=args.minify,
            merge=args.merge,
            in_place=args.in_place,
            dry_run=args.dry_run,
        )
        print(f"{verb} {r.rule_count} rule(s) to {r.css_path}")
        print(f"{verb} cleaned HTML to {r.html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

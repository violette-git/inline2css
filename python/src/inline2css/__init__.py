"""inline2css: extract inline HTML styles into an external stylesheet."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional

from .core import (
    Registry,
    Rule,
    canonical,
    convert,
    make_class_name,
    parse_declarations,
    parse_existing_css,
    render_stylesheet,
)

__version__ = "1.0.0"

__all__ = [
    "Registry",
    "Rule",
    "canonical",
    "convert",
    "make_class_name",
    "parse_declarations",
    "parse_existing_css",
    "render_stylesheet",
    "convert_file",
    "convert_directory",
]


@dataclass
class FileResult:
    css_path: str
    html_path: str
    rule_count: int
    wrote: bool


@dataclass
class DirResult:
    css_path: str
    html_paths: List[str]
    rule_count: int
    wrote: bool


def convert_file(
    input_path: str,
    *,
    css: Optional[str] = None,
    html_out: Optional[str] = None,
    naming: str = "sequential",
    prefix: str = "i2c-",
    minify: bool = False,
    merge: bool = False,
    in_place: bool = False,
    dry_run: bool = False,
) -> FileResult:
    with open(input_path, encoding="utf-8") as fh:
        html = fh.read()

    directory = os.path.dirname(input_path)
    css_path = css or os.path.join(directory, "styles.css")
    css_href = os.path.basename(css_path)

    registry = Registry()
    if merge and os.path.exists(css_path):
        with open(css_path, encoding="utf-8") as fh:
            registry = parse_existing_css(fh.read())

    new_html, rules = convert(
        html, prefix=prefix, naming=naming, css_href=css_href, registry=registry
    )
    css_text = render_stylesheet(rules, minify)

    if in_place:
        html_path = input_path
    elif html_out:
        html_path = html_out
    else:
        base, ext = os.path.splitext(input_path)
        html_path = f"{base}.cleaned{ext}"

    if not dry_run:
        with open(css_path, "w", encoding="utf-8") as fh:
            fh.write(css_text)
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(new_html)

    return FileResult(css_path, html_path, len(rules), not dry_run)


def convert_directory(
    directory: str,
    *,
    css: Optional[str] = None,
    naming: str = "sequential",
    prefix: str = "i2c-",
    minify: bool = False,
    merge: bool = False,
    in_place: bool = False,
    dry_run: bool = False,
) -> DirResult:
    css_path = css or os.path.join(directory, "styles.css")

    registry = Registry()
    if merge and os.path.exists(css_path):
        with open(css_path, encoding="utf-8") as fh:
            registry = parse_existing_css(fh.read())

    html_files: List[str] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != "node_modules" and not d.startswith(".")]
        for name in files:
            if name.lower().endswith((".html", ".htm")):
                html_files.append(os.path.join(root, name))

    html_paths: List[str] = []
    for path in sorted(html_files):
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        rel = os.path.relpath(css_path, os.path.dirname(path)).replace(os.sep, "/")
        new_html, _ = convert(
            html, prefix=prefix, naming=naming, css_href=rel, registry=registry
        )
        if in_place:
            out = path
        else:
            base, ext = os.path.splitext(path)
            out = f"{base}.cleaned{ext}"
        if not dry_run:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(new_html)
        html_paths.append(out)

    css_text = render_stylesheet(list(registry.by_key.values()), minify)
    if not dry_run:
        with open(css_path, "w", encoding="utf-8") as fh:
            fh.write(css_text)

    return DirResult(css_path, html_paths, registry.size(), not dry_run)

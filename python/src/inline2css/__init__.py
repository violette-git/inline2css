"""inline2css: extract inline HTML styles into an external stylesheet.

Resolve mode additionally tree-shakes framework stylesheets (Bootstrap,
Tailwind, ...) down to the rules the HTML uses and folds them into the same
output file.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Tuple, Union

from bs4 import BeautifulSoup

from .core import (
    BOOST_SUFFIX,
    Registry,
    Rule,
    canonical,
    convert,
    make_class_name,
    parse_declarations,
    parse_existing_css,
    render_rule,
    render_stylesheet,
)
from .resolve import (
    BOOTSTRAP_SAFELIST,
    LAYER_NAME,
    ClassPool,
    ResolveResult,
    collect_used_classes,
    detect_bootstrap,
    href_basename,
    load_css_source,
    parse_safelist,
    preset_entries,
    resolve_stylesheet,
    selector_is_used,
)

__version__ = "1.1.0"

__all__ = [
    "BOOTSTRAP_SAFELIST",
    "BOOST_SUFFIX",
    "LAYER_NAME",
    "ClassPool",
    "Registry",
    "ResolveResult",
    "Rule",
    "canonical",
    "collect_used_classes",
    "convert",
    "convert_directory",
    "convert_file",
    "detect_bootstrap",
    "load_css_source",
    "make_class_name",
    "parse_declarations",
    "parse_existing_css",
    "parse_safelist",
    "render_rule",
    "render_stylesheet",
    "resolve_directory",
    "resolve_file",
    "resolve_stylesheet",
    "selector_is_used",
    "__version__",
]

AUTO_SAFELIST_NOTE = (
    "note: Bootstrap JavaScript detected, applying the bootstrap safelist preset "
    "(use --no-auto-safelist to disable)"
)


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


@dataclass
class ResolveFileResult:
    css_path: str
    html_path: str
    inline_rules: int
    resolved_kept: int
    resolved_dropped: int
    pruned_at_rules: int
    wrote: bool
    auto_safelist: bool = False
    sources: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    css: str = ""


@dataclass
class ResolveDirResult:
    css_path: str
    html_paths: List[str]
    inline_rules: int
    resolved_kept: int
    resolved_dropped: int
    pruned_at_rules: int
    wrote: bool
    auto_safelist: bool = False
    sources: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    css: str = ""


def _cleaned_path(path: str) -> str:
    base, ext = os.path.splitext(path)
    return f"{base}.cleaned{ext}"


def _write(path: str, text: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _find_html(directory: str) -> List[str]:
    found: List[str] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if d != "node_modules" and not d.startswith("."))
        for name in files:
            if name.lower().endswith((".html", ".htm")) and ".cleaned." not in name:
                found.append(os.path.join(root, name))
    return sorted(found)


def _load_registry(css_path: str, merge: bool, prefix: Optional[str] = None) -> Registry:
    if merge and os.path.exists(css_path):
        with open(css_path, encoding="utf-8") as fh:
            registry = parse_existing_css(fh.read())
        if prefix is not None:
            # Resolve mode: only reuse classes inline2css generated itself, not
            # single-class framework rules that live in the same file.
            for key in [k for k, r in registry.by_key.items() if not r.class_name.startswith(prefix)]:
                del registry.by_key[key]
            registry.counter = registry.size()
        return registry
    return Registry()


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
    boost: bool = False,
) -> FileResult:
    """Extract the inline styles of one HTML file into a stylesheet."""
    with open(input_path, encoding="utf-8") as fh:
        html = fh.read()

    directory = os.path.dirname(input_path)
    css_path = css or os.path.join(directory, "styles.css")
    html_path = input_path if in_place else (html_out or _cleaned_path(input_path))
    css_href = os.path.relpath(css_path, os.path.dirname(html_path) or ".").replace(os.sep, "/")

    registry = _load_registry(css_path, merge)
    new_html, rules = convert(
        html, prefix=prefix, naming=naming, css_href=css_href, registry=registry
    )
    css_text = render_stylesheet(rules, minify, boost=boost)

    if not dry_run:
        _write(css_path, css_text)
        _write(html_path, new_html)

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
    boost: bool = False,
) -> DirResult:
    """Extract inline styles from every .html/.htm file under ``directory``
    into one shared, deduplicated stylesheet."""
    css_path = css or os.path.join(directory, "styles.css")
    registry = _load_registry(css_path, merge)

    html_paths: List[str] = []
    for path in _find_html(directory):
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        rel = os.path.relpath(css_path, os.path.dirname(path)).replace(os.sep, "/")
        new_html, _ = convert(
            html, prefix=prefix, naming=naming, css_href=rel, registry=registry
        )
        out = path if in_place else _cleaned_path(path)
        if not dry_run:
            _write(out, new_html)
        html_paths.append(out)

    css_text = render_stylesheet(list(registry.by_key.values()), minify, boost=boost)
    if not dry_run:
        _write(css_path, css_text)

    return DirResult(css_path, html_paths, registry.size(), not dry_run)


# ---------------------------------------------------------------------------
# Resolve mode
# ---------------------------------------------------------------------------


def _is_stylesheet_link(tag) -> bool:
    rel = tag.get("rel") or []
    if isinstance(rel, str):
        rel = rel.split()
    return "stylesheet" in [r.lower() for r in rel] and bool(tag.get("href"))


def _source_key(src: str, base_dir: str) -> str:
    if "://" in src or src.startswith("//"):
        return src
    path = src.split("?", 1)[0].split("#", 1)[0]
    return os.path.normcase(os.path.abspath(os.path.join(base_dir, path)))


class _SourceSet:
    """Loads each distinct stylesheet once, in first-seen order."""

    def __init__(self) -> None:
        self.loaded: List[Tuple[str, str]] = []
        self.keys: dict = {}
        self.failed: set = set()

    def add(self, src: str, base_dir: str, required: bool) -> bool:
        key = _source_key(src, base_dir)
        if key in self.keys:
            return True
        if key in self.failed:
            return False
        try:
            text, origin = load_css_source(src, base_dir)
        except Exception as exc:  # noqa: BLE001
            if required:
                raise RuntimeError(f"Could not load {src}: {exc}") from exc
            print(f"warn: could not load linked stylesheet {src}: {exc}", file=sys.stderr)
            self.failed.add(key)
            return False
        self.keys[key] = origin
        self.loaded.append((text, origin))
        return True


def _rewrite_links(soup, new_href: str, remove) -> None:
    """Remove folded-in <link rel=stylesheet> tags (``remove(href)`` decides)
    and put one link to the output stylesheet where the first one was, or at
    the end of <head> when none was removed."""
    anchor = None
    existing = None
    for tag in soup.find_all("link"):
        if not _is_stylesheet_link(tag):
            continue
        href = tag["href"]
        if href == new_href:
            existing = tag
            continue
        if remove(href):
            if anchor is None and existing is None:
                anchor = tag
            else:
                tag.decompose()
    if existing is not None:
        if anchor is not None:
            anchor.decompose()
        return
    link = soup.new_tag("link", rel="stylesheet", href=new_href)
    if anchor is not None:
        anchor.replace_with(link)
        return
    head = soup.find("head")
    if head is None:
        head = soup.new_tag("head")
        html_tag = soup.find("html")
        (html_tag or soup).insert(0, head)
    head.append(link)


def _remover(resolve_linked: bool, explicit: Sequence[str], folded_keys: set, page_dir: str):
    explicit_names = {href_basename(s) for s in explicit if href_basename(s)}

    def remove(href: str) -> bool:
        if resolve_linked and _source_key(href, page_dir) in folded_keys:
            return True
        return href_basename(href) in explicit_names
    return remove


def _safelist_entries(safelist, safelist_preset, auto_safelist: bool, soups) -> Tuple[list, bool]:
    entries = list(safelist or ())
    presets = [safelist_preset] if isinstance(safelist_preset, str) else list(safelist_preset or ())
    auto = False
    if auto_safelist and "bootstrap" not in [p.lower() for p in presets]:
        if any(detect_bootstrap(s) for s in soups):
            presets.append("bootstrap")
            auto = True
    entries.extend(preset_entries(presets))
    return entries, auto


def _resolve_pages(
    pages: List[str],
    *,
    css_path: str,
    out_paths: List[str],
    resolve: Sequence[str],
    resolve_linked: bool,
    naming: str,
    prefix: str,
    minify: bool,
    merge: bool,
    dry_run: bool,
    safelist,
    safelist_preset,
    auto_safelist: bool,
    layer: bool,
    boost: bool,
    keep_all_at_rules: bool,
    cwd: Optional[str],
):
    registry = _load_registry(css_path, merge, prefix)
    soups = []
    used: set = set()
    for path in pages:
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        new_html, _ = convert(html, prefix=prefix, naming=naming, inject_link=False, registry=registry)
        soup = BeautifulSoup(new_html, "html.parser")
        soups.append(soup)
        used |= collect_used_classes(soup)

    entries, auto = _safelist_entries(safelist, safelist_preset, auto_safelist, soups)

    sources = _SourceSet()
    folded: List[set] = []
    for path, soup, out in zip(pages, soups, out_paths):
        page_dir = os.path.dirname(os.path.abspath(path))
        keys: set = set()
        if resolve_linked:
            own = os.path.normcase(os.path.abspath(css_path))
            for tag in soup.find_all("link"):
                if not _is_stylesheet_link(tag):
                    continue
                href = tag["href"]
                if _source_key(href, page_dir) == own:
                    continue
                if sources.add(href, page_dir, required=False):
                    keys.add(_source_key(href, page_dir))
        folded.append(keys)
    base = cwd or os.getcwd()
    for src in resolve or ():
        sources.add(src, base, required=True)

    inline_rules = list(registry.by_key.values())
    result = resolve_stylesheet(
        sources.loaded,
        used,
        safelist=entries,
        minify=minify,
        layer=layer,
        keep_all_at_rules=keep_all_at_rules,
        css_out=css_path,
        inline_rules=inline_rules,
        boost=boost,
    )

    html_out: List[str] = []
    for path, soup, out, keys in zip(pages, soups, out_paths, folded):
        href = os.path.relpath(css_path, os.path.dirname(os.path.abspath(out))).replace(os.sep, "/")
        page_dir = os.path.dirname(os.path.abspath(path))
        _rewrite_links(soup, href, _remover(resolve_linked, list(resolve or ()), keys, page_dir))
        html_out.append(str(soup))

    if not dry_run:
        _write(css_path, result.css)
        for out, text in zip(out_paths, html_out):
            _write(out, text)

    notes = [AUTO_SAFELIST_NOTE] if auto else []
    return result, inline_rules, auto, [o for _, o in sources.loaded], notes


def resolve_file(
    input_path: str,
    *,
    resolve: Sequence[str] = (),
    resolve_linked: bool = False,
    css: Optional[str] = None,
    html_out: Optional[str] = None,
    naming: str = "sequential",
    prefix: str = "i2c-",
    minify: bool = False,
    merge: bool = False,
    in_place: bool = False,
    dry_run: bool = False,
    safelist: Iterable[Union[str, "object"]] = (),
    safelist_preset: Union[str, Sequence[str], None] = (),
    auto_safelist: bool = True,
    layer: bool = True,
    boost: bool = False,
    keep_all_at_rules: bool = False,
    cwd: Optional[str] = None,
) -> ResolveFileResult:
    """Extract inline styles AND tree-shake the framework stylesheets in
    ``resolve`` (paths relative to ``cwd`` or URLs) and, with
    ``resolve_linked``, the page's own <link rel=stylesheet> sheets, into one
    output stylesheet. Folded-in links are replaced by one link to it."""
    css_path = css or os.path.join(os.path.dirname(input_path), "styles.css")
    out = input_path if in_place else (html_out or _cleaned_path(input_path))
    result, inline_rules, auto, srcs, notes = _resolve_pages(
        [input_path], css_path=css_path, out_paths=[out], resolve=resolve,
        resolve_linked=resolve_linked, naming=naming, prefix=prefix, minify=minify,
        merge=merge, dry_run=dry_run, safelist=safelist, safelist_preset=safelist_preset,
        auto_safelist=auto_safelist, layer=layer, boost=boost,
        keep_all_at_rules=keep_all_at_rules, cwd=cwd,
    )
    return ResolveFileResult(
        css_path, out, len(inline_rules), result.kept_rules, result.dropped_rules,
        result.pruned_at_rules, not dry_run, auto, srcs, notes, result.css,
    )


def resolve_directory(
    directory: str,
    *,
    resolve: Sequence[str] = (),
    resolve_linked: bool = False,
    css: Optional[str] = None,
    naming: str = "sequential",
    prefix: str = "i2c-",
    minify: bool = False,
    merge: bool = False,
    in_place: bool = False,
    dry_run: bool = False,
    safelist: Iterable[Union[str, "object"]] = (),
    safelist_preset: Union[str, Sequence[str], None] = (),
    auto_safelist: bool = True,
    layer: bool = True,
    boost: bool = False,
    keep_all_at_rules: bool = False,
    cwd: Optional[str] = None,
) -> ResolveDirResult:
    """Resolve mode for a whole site: one shared output stylesheet built from
    the union of classes on every .html/.htm page (node_modules and dot
    directories skipped), with inline styles deduplicated across pages."""
    css_path = css or os.path.join(directory, "styles.css")
    pages = _find_html(directory)
    outs = [p if in_place else _cleaned_path(p) for p in pages]
    result, inline_rules, auto, srcs, notes = _resolve_pages(
        pages, css_path=css_path, out_paths=outs, resolve=resolve,
        resolve_linked=resolve_linked, naming=naming, prefix=prefix, minify=minify,
        merge=merge, dry_run=dry_run, safelist=safelist, safelist_preset=safelist_preset,
        auto_safelist=auto_safelist, layer=layer, boost=boost,
        keep_all_at_rules=keep_all_at_rules, cwd=cwd,
    )
    return ResolveDirResult(
        css_path, outs, len(inline_rules), result.kept_rules, result.dropped_rules,
        result.pruned_at_rules, not dry_run, auto, srcs, notes, result.css,
    )

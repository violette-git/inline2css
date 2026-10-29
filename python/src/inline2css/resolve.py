"""Resolve mode: tree-shake framework stylesheets down to the rules a page uses.

Parsing is done with tinycss2. Grouping at-rules (@media, @supports, @layer,
@container, @scope, @starting-style, @document) are walked recursively, as are
nested style rules (CSS nesting). The output is rendered from a small
intermediate tree, so the pretty printer can never break a string, a url(...)
or a parenthesised expression across lines.
"""

from __future__ import annotations

import os
import posixpath
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable, List, Optional, Sequence, Set, Tuple, Union

import tinycss2
from tinycss2 import ast as css_ast

LAYER_NAME = "inline2css-framework"
BOOST_SUFFIX = r":not(#\#)"

BOOTSTRAP_SAFELIST: Tuple[str, ...] = (
    "show", "showing", "hiding", "collapse", "collapsing", "collapse-horizontal",
    "fade", "active", "disabled", "open", "modal-open", "modal-backdrop",
    "modal-static", "offcanvas-backdrop", "is-valid", "is-invalid",
    "was-validated", "tooltip", "tooltip-inner", "tooltip-arrow", "popover",
    "popover-arrow", "popover-header", "popover-body", "carousel-item-next",
    "carousel-item-prev", "carousel-item-start", "carousel-item-end",
    "dropdown-menu-end", "toast", "/^bs-tooltip-/", "/^bs-popover-/",
)
PRESETS = {"bootstrap": BOOTSTRAP_SAFELIST}

_BOOTSTRAP_SCRIPT_RE = re.compile(r"bootstrap(\.bundle)?(\.min)?\.js", re.I)

# Functional pseudo-classes that match when ANY selector in their argument
# list could match.
_ANY_OF = {"is", "where", "matches", "-webkit-any", "-moz-any", "has"}

# Grouping at-rules whose contents are pruned like the top level.
_GROUPING = {"media", "supports", "layer", "container", "scope",
             "starting-style", "document", "-moz-document"}

_KEYFRAMES = {"keyframes", "-webkit-keyframes", "-moz-keyframes", "-o-keyframes"}


# ---------------------------------------------------------------------------
# Class pool and safelist
# ---------------------------------------------------------------------------


class ClassPool:
    """A set of class names plus regex patterns. ``name in pool`` is True when
    the name is in the set or any pattern matches it."""

    def __init__(self, classes: Iterable[str] = (), patterns: Iterable["re.Pattern"] = ()):
        self.classes: Set[str] = set(classes)
        self.patterns: List["re.Pattern"] = list(patterns)

    def __contains__(self, name: str) -> bool:
        if name in self.classes:
            return True
        return any(p.search(name) for p in self.patterns)

    def add(self, name: str) -> None:
        self.classes.add(name)

    def update(self, other: Union["ClassPool", Iterable[str]]) -> None:
        if isinstance(other, ClassPool):
            self.classes |= other.classes
            self.patterns.extend(other.patterns)
        else:
            self.classes.update(other)

    def __len__(self) -> int:
        return len(self.classes)


_REGEX_ENTRY = re.compile(r"^/(.+)/([imsx]*)$", re.S)


def parse_safelist(entries: Iterable[Union[str, "re.Pattern"]]) -> ClassPool:
    """Turn safelist entries into a pool. Strings wrapped in slashes
    (``/^tooltip/``, optionally with flags like ``/x/i``) are regexes."""
    pool = ClassPool()
    for entry in entries or ():
        if isinstance(entry, re.Pattern):
            pool.patterns.append(entry)
            continue
        m = _REGEX_ENTRY.match(entry)
        if m:
            flags = 0
            for f in m.group(2):
                flags |= {"i": re.I, "m": re.M, "s": re.S, "x": re.X}[f]
            pool.patterns.append(re.compile(m.group(1), flags))
        elif entry:
            pool.add(entry)
    return pool


def preset_entries(names: Iterable[str]) -> List[str]:
    out: List[str] = []
    for name in names or ():
        key = name.lower()
        if key not in PRESETS:
            raise ValueError(f"Unknown safelist preset: {name} (available: {', '.join(PRESETS)})")
        out.extend(PRESETS[key])
    return out


def _soup(html_or_soup):
    from bs4 import BeautifulSoup

    if isinstance(html_or_soup, str):
        return BeautifulSoup(html_or_soup, "html.parser")
    return html_or_soup


def collect_used_classes(html_or_soup) -> Set[str]:
    """Every class name used anywhere in the HTML (string or BeautifulSoup)."""
    soup = _soup(html_or_soup)
    used: Set[str] = set()
    for el in soup.find_all(class_=True):
        value = el.get("class")
        if isinstance(value, str):
            value = value.split()
        used.update(c for c in value if c)
    return used


def detect_bootstrap(html_or_soup) -> bool:
    """True when the page loads Bootstrap's JavaScript or uses data-bs-* attributes."""
    soup = _soup(html_or_soup)
    for script in soup.find_all("script", src=True):
        if _BOOTSTRAP_SCRIPT_RE.search(script["src"]):
            return True
    for el in soup.find_all(True):
        if any(str(a).lower().startswith("data-bs-") for a in el.attrs):
            return True
    return False


# ---------------------------------------------------------------------------
# Selector matching
# ---------------------------------------------------------------------------


def _split_commas(tokens: Sequence) -> List[list]:
    parts: List[list] = [[]]
    for tok in tokens:
        if tok.type == "literal" and tok.value == ",":
            parts.append([])
        else:
            parts[-1].append(tok)
    return [p for p in parts if any(t.type not in ("whitespace", "comment") for t in p)]


def _meaningful(tokens: Sequence, i: int):
    """Next token at or after i (no whitespace skipping: selectors are tight)."""
    return tokens[i] if i < len(tokens) else None


def _check(tokens: Sequence, pool, state: dict) -> bool:
    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        if tok.type == "literal" and tok.value == ".":
            nxt = _meaningful(tokens, i + 1)
            if nxt is not None and nxt.type == "ident":
                state["hook"] = True
                if nxt.value not in pool:
                    return False
                i += 2
                continue
        elif tok.type == "literal" and tok.value == ":":
            nxt = _meaningful(tokens, i + 1)
            if nxt is not None and nxt.type == "literal" and nxt.value == ":":
                # Pseudo-element: ::part(x), ::slotted(.x), ::before. Ignore args.
                i += 3
                continue
            if nxt is not None and nxt.type == "function":
                name = nxt.lower_name
                if name in _ANY_OF:
                    branches = _split_commas(nxt.arguments)
                    if not any(_check(b, pool, state) for b in branches):
                        return False
                # :not(...) and every other functional pseudo: classes ignored.
                i += 2
                continue
            i += 2
            continue
        i += 1
    return True


def _tokens(selector) -> list:
    if isinstance(selector, str):
        return tinycss2.parse_component_value_list(selector, skip_comments=True)
    return list(selector)


def selector_is_used(selector, used, keep_element_selectors: bool = True) -> bool:
    """Could ``selector`` (a string or tinycss2 tokens) match, given the class
    pool ``used`` (a set or ClassPool)?

    Top-level classes are required; classes inside :not() and other functional
    pseudos are ignored; :is()/:where()/:matches()/:-webkit-any()/:-moz-any()/
    :has() are satisfied when any argument selector is. Selectors with no class
    hook (body, :root, a:hover) return ``keep_element_selectors``."""
    state = {"hook": False}
    ok = _check(_tokens(selector), used, state)
    if not state["hook"]:
        return ok and keep_element_selectors
    return ok


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

_WS = css_ast.WhitespaceToken(0, 0, " ")
_SKIP_URL = re.compile(r"^(?:[a-zA-Z][a-zA-Z0-9+.\-]*:|//|/|#)")


def make_url_rewriter(source: Optional[str], css_out: Optional[str]) -> Optional[Callable[[str], str]]:
    """Return a function that rewrites relative url() values found in a
    stylesheet loaded from ``source`` (file path or http(s) URL) so they keep
    pointing at the same resource from the output stylesheet ``css_out``."""
    if not source:
        return None
    if re.match(r"^https?://", source, re.I):
        def remote(url: str) -> str:
            if not url or url.startswith(("data:", "#")):
                return url
            return urllib.parse.urljoin(source, url)
        return remote
    if not css_out:
        return None
    src_dir = os.path.dirname(os.path.abspath(source))
    out_dir = os.path.dirname(os.path.abspath(css_out))
    if os.path.normcase(src_dir) == os.path.normcase(out_dir):
        return None

    def local(url: str) -> str:
        if not url or _SKIP_URL.match(url):
            return url
        path, sep, rest = url.partition("?")
        if not sep:
            path, sep, rest = url.partition("#")
        target = os.path.normpath(os.path.join(src_dir, urllib.parse.unquote(path)))
        rel = os.path.relpath(target, out_dir).replace(os.sep, "/")
        return urllib.parse.quote(rel, safe="/:@!$&'()*+,;=-._~") + sep + rest
    return local


def _norm(tokens, url_fn) -> list:
    out: list = []
    for t in tokens:
        kind = t.type
        if kind == "comment":
            continue
        if kind == "whitespace":
            if out and out[-1].type == "whitespace":
                continue
            out.append(_WS)
            continue
        if kind == "url" and url_fn:
            new = url_fn(t.value)
            if new != t.value:
                t = css_ast.URLToken(t.source_line, t.source_column, new,
                                     'url("%s")' % tinycss2.serializer.serialize_string_value(new))
        elif kind == "function":
            args = t.arguments
            if url_fn and t.lower_name == "url":
                strs = [a for a in args if a.type == "string"]
                if len(strs) == 1:
                    new = url_fn(strs[0].value)
                    args = [css_ast.StringToken(a.source_line, a.source_column, new,
                                                '"%s"' % tinycss2.serializer.serialize_string_value(new))
                            if a is strs[0] else a for a in args]
            t = css_ast.FunctionBlock(t.source_line, t.source_column, t.name, _norm(args, url_fn))
        elif kind == "() block":
            t = css_ast.ParenthesesBlock(t.source_line, t.source_column, _norm(t.content, url_fn))
        elif kind == "[] block":
            t = css_ast.SquareBracketsBlock(t.source_line, t.source_column, _norm(t.content, url_fn))
        elif kind == "{} block":
            t = css_ast.CurlyBracketsBlock(t.source_line, t.source_column, _norm(t.content, url_fn))
        out.append(t)
    return out


def _ser(tokens, url_fn=None) -> str:
    return tinycss2.serialize(_norm(tokens, url_fn)).strip()


# ---------------------------------------------------------------------------
# Intermediate tree
# ---------------------------------------------------------------------------


@dataclass
class Decl:
    name: str
    value: str
    important: bool = False


@dataclass
class StyleRule:
    selectors: List[str]
    children: list


@dataclass
class AtRule:
    keyword: str  # lower-case name, without "@"
    prelude: str
    children: Optional[list]  # None for statement at-rules (@layer a, b;)


@dataclass
class Comment:
    text: str


@dataclass
class _Ctx:
    pool: object
    url_fn: Optional[Callable[[str], str]]
    imports: list
    namespaces: list
    kept: int = 0
    dropped: int = 0


def _decl(node, url_fn) -> Decl:
    value = _ser(node.value, url_fn)
    if not value and node.name.startswith("--"):
        value = " "
    return Decl(node.name, value, node.important)


def _contents(content, mode: str):
    if mode == "rules":
        return tinycss2.parse_rule_list(content, skip_comments=True, skip_whitespace=True)
    return tinycss2.parse_blocks_contents(content, skip_comments=True, skip_whitespace=True)


def _copy(nodes, ctx: _Ctx) -> list:
    """Convert nodes to the tree without pruning (keyframes, @font-face ...)."""
    out: list = []
    for node in nodes:
        if node.type == "declaration":
            out.append(_decl(node, ctx.url_fn))
        elif node.type == "qualified-rule":
            sels = [_ser(s) for s in _split_commas(node.prelude)]
            out.append(StyleRule(sels, _copy(_contents(node.content, "mixed"), ctx)))
        elif node.type == "at-rule":
            kw = node.lower_at_keyword
            kids = None
            if node.content is not None:
                mode = "rules" if kw in _KEYFRAMES else "mixed"
                kids = _copy(_contents(node.content, mode), ctx)
            out.append(AtRule(kw, _ser(node.prelude, ctx.url_fn), kids))
    return out


def _import_prelude(node, url_fn, layer: bool) -> str:
    toks = [t for t in node.prelude if t.type != "comment"]
    while toks and toks[0].type == "whitespace":
        toks.pop(0)
    url = None
    if toks and toks[0].type in ("string", "url"):
        url = toks.pop(0).value
    elif toks and toks[0].type == "function" and toks[0].lower_name == "url":
        strs = [a for a in toks[0].arguments if a.type == "string"]
        url = strs[0].value if strs else ""
        toks.pop(0)
    if url is None:
        return _ser(node.prelude, url_fn)
    if url_fn:
        url = url_fn(url)
    rest = _norm(toks, None)
    layer_part = ""
    # Existing layer / layer(name) on the import.
    while rest and rest[0].type == "whitespace":
        rest.pop(0)
    if rest and rest[0].type == "ident" and rest[0].lower_value == "layer":
        rest.pop(0)
        layer_part = f"layer({LAYER_NAME})" if layer else "layer"
    elif rest and rest[0].type == "function" and rest[0].lower_name == "layer":
        inner = _ser(rest.pop(0).arguments)
        layer_part = f"layer({LAYER_NAME}.{inner})" if layer else f"layer({inner})"
    elif layer:
        layer_part = f"layer({LAYER_NAME})"
    tail = tinycss2.serialize(rest).strip()
    parts = ['url("%s")' % tinycss2.serializer.serialize_string_value(url)]
    if layer_part:
        parts.append(layer_part)
    if tail:
        parts.append(tail)
    return " ".join(parts)


def _prune(nodes, ctx: _Ctx, in_style: bool, layer: bool) -> list:
    out: list = []
    for node in nodes:
        t = node.type
        if t == "comment":
            if node.value.startswith("!"):
                out.append(Comment(node.value))
            continue
        if t == "declaration":
            if in_style:
                out.append(_decl(node, ctx.url_fn))
            continue
        if t == "qualified-rule":
            selectors = _split_commas(node.prelude)
            keep = [s for s in selectors if selector_is_used(s, ctx.pool)]
            if not keep:
                ctx.dropped += 1
                continue
            ctx.kept += 1
            kids = _prune(_contents(node.content, "mixed"), ctx, True, layer)
            out.append(StyleRule([_ser(s) for s in keep], kids))
            continue
        if t != "at-rule":
            continue  # parse errors
        kw = node.lower_at_keyword
        if kw == "charset":
            continue
        if kw == "import":
            ctx.imports.append(AtRule("import", _import_prelude(node, ctx.url_fn, layer), None))
            continue
        if kw == "namespace":
            ctx.namespaces.append(AtRule("namespace", _ser(node.prelude, ctx.url_fn), None))
            continue
        prelude = _ser(node.prelude, ctx.url_fn)
        if kw in _GROUPING and node.content is not None:
            mode = "mixed" if in_style else "rules"
            kids = _prune(_contents(node.content, mode), ctx, in_style, layer)
            out.append(AtRule(kw, prelude, kids))
            continue
        if node.content is None:
            out.append(AtRule(kw, prelude, None))
            continue
        mode = "rules" if kw in _KEYFRAMES else "mixed"
        out.append(AtRule(kw, prelude, _copy(_contents(node.content, mode), ctx)))
    return out


def _has_content(items) -> bool:
    return any(not isinstance(i, Comment) for i in items)


def _drop_empty(items: list) -> list:
    """Remove grouping blocks that ended up empty. An empty named @layer block
    becomes a statement (@layer name;) so layer order is preserved."""
    out: list = []
    for item in items:
        if isinstance(item, AtRule) and item.keyword in _GROUPING and item.children is not None:
            item.children = _drop_empty(item.children)
            if not _has_content(item.children):
                if item.keyword == "layer" and item.prelude:
                    out.append(AtRule("layer", item.prelude, None))
                continue
        elif isinstance(item, StyleRule):
            item.children = _drop_empty(item.children)
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# @keyframes / @font-face pruning
# ---------------------------------------------------------------------------

_ANIM_PROPS = re.compile(r"^(-webkit-|-moz-|-o-)?animation(-name)?$")
_FONT_PROPS = {"font", "font-family"}


def _walk_decls(items):
    for item in items:
        if isinstance(item, Decl):
            yield item
        elif isinstance(item, (StyleRule, AtRule)) and item.children:
            if isinstance(item, AtRule) and (item.keyword in _KEYFRAMES or item.keyword == "font-face"):
                continue
            yield from _walk_decls(item.children)


def _idents(value: str) -> Set[str]:
    names: Set[str] = set()

    def visit(tokens):
        for t in tokens:
            if t.type in ("ident", "string"):
                names.add(t.value)
            elif t.type == "function":
                visit(t.arguments)
            elif t.type in ("() block", "[] block"):
                visit(t.content)
    visit(tinycss2.parse_component_value_list(value, skip_comments=True))
    return names


def _families(value: str) -> Set[str]:
    out: Set[str] = set()

    def visit(tokens):
        for part in _split_commas(tokens):
            run: List[str] = []
            for t in part:
                if t.type == "string":
                    out.add(t.value.lower())
                elif t.type == "ident":
                    run.append(t.value)
                    out.add(t.value.lower())
                elif t.type == "whitespace":
                    continue
                else:
                    if t.type == "function":
                        visit(t.arguments)
                    if run:
                        out.add(" ".join(run).lower())
                    run = []
            if run:
                out.add(" ".join(run).lower())
            # Also every trailing run of idents (font shorthand: "bold 1rem Open Sans").
            words = [t.value for t in part if t.type == "ident"]
            for k in range(len(words)):
                out.add(" ".join(words[k:]).lower())
    visit(tinycss2.parse_component_value_list(value, skip_comments=True))
    return out


def _keyframe_name(prelude: str) -> str:
    toks = [t for t in tinycss2.parse_component_value_list(prelude) if t.type != "whitespace"]
    return toks[0].value if toks and toks[0].type in ("ident", "string") else prelude.strip()


def _fontface_family(item: AtRule) -> Optional[str]:
    for d in item.children or []:
        if isinstance(d, Decl) and d.name.lower() == "font-family":
            toks = [t for t in tinycss2.parse_component_value_list(d.value) if t.type != "whitespace"]
            if len(toks) == 1 and toks[0].type == "string":
                return toks[0].value.lower()
            return " ".join(t.value for t in toks if t.type == "ident").lower()
    return None


def prune_at_rules(items: list, extra_decls: Iterable[Decl] = ()) -> Tuple[list, int]:
    """Drop @keyframes not referenced by an animation value and @font-face
    whose family is not referenced by a font/font-family value. Custom
    property values count as references too (Tailwind uses var(--animate-x))."""
    anim: Set[str] = set()
    fonts: Set[str] = set()
    for d in list(_walk_decls(items)) + list(extra_decls):
        name = d.name.lower()
        custom = d.name.startswith("--")
        if custom or _ANIM_PROPS.match(name):
            anim |= _idents(d.value)
        if custom or name in _FONT_PROPS:
            fonts |= _families(d.value)
    removed = 0

    def visit(nodes):
        nonlocal removed
        out = []
        for item in nodes:
            if isinstance(item, AtRule):
                if item.keyword in _KEYFRAMES and item.children is not None:
                    if _keyframe_name(item.prelude) not in anim:
                        removed += 1
                        continue
                elif item.keyword == "font-face":
                    fam = _fontface_family(item)
                    if fam is not None and fam not in fonts:
                        removed += 1
                        continue
                elif item.children is not None and item.keyword in _GROUPING:
                    item.children = visit(item.children)
            elif isinstance(item, StyleRule):
                item.children = visit(item.children)
            out.append(item)
        return out

    return visit(items), removed


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _decl_text(d: Decl, minify: bool) -> str:
    imp = ("!important" if minify else " !important") if d.important else ""
    sep = ":" if minify else ": "
    return f"{d.name}{sep}{d.value}{imp}"


def render_tree(items: list, minify: bool = False, depth: int = 0) -> str:
    """Render the tree. Strings and url(...) values are emitted whole (they are
    single tokens), so newlines are only ever placed between rules and
    declarations, never inside a value."""
    if minify:
        parts = []
        for i, item in enumerate(items):
            if isinstance(item, Decl):
                parts.append(_decl_text(item, True) + (";" if i < len(items) - 1 else ""))
            elif isinstance(item, Comment):
                parts.append(f"/*{item.text}*/")
            elif isinstance(item, StyleRule):
                parts.append(",".join(item.selectors) + "{" + render_tree(item.children, True) + "}")
            else:
                head = f"@{item.keyword}" + (f" {item.prelude}" if item.prelude else "")
                if item.children is None:
                    parts.append(head + ";")
                else:
                    parts.append(head + "{" + render_tree(item.children, True) + "}")
        return "".join(parts)

    pad = "    " * depth
    lines: List[str] = []
    for item in items:
        if isinstance(item, Decl):
            lines.append(f"{pad}{_decl_text(item, False)};")
        elif isinstance(item, Comment):
            lines.append(f"{pad}/*{item.text}*/")
        elif isinstance(item, StyleRule):
            lines.append(f"{pad}{', '.join(item.selectors)} {{")
            body = render_tree(item.children, False, depth + 1)
            if body:
                lines.append(body)
            lines.append(f"{pad}}}")
        else:
            head = f"{pad}@{item.keyword}" + (f" {item.prelude}" if item.prelude else "")
            if item.children is None:
                lines.append(head + ";")
            else:
                lines.append(head + " {")
                body = render_tree(item.children, False, depth + 1)
                if body:
                    lines.append(body)
                lines.append(f"{pad}}}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class ResolveResult:
    css: str
    kept_rules: int
    dropped_rules: int
    pruned_at_rules: int = 0


Source = Tuple[str, Optional[str]]  # (css text, origin path or URL)


def resolve_stylesheet(
    css: Union[str, Sequence[Source]],
    used,
    *,
    safelist: Iterable[Union[str, "re.Pattern"]] = (),
    minify: bool = False,
    layer: bool = True,
    keep_all_at_rules: bool = False,
    source: Optional[str] = None,
    css_out: Optional[str] = None,
    inline_rules: Sequence = (),
    boost: bool = False,
) -> ResolveResult:
    """Tree-shake ``css`` down to the rules that can match the class pool.

    ``css`` is a CSS string, or a list of ``(css_text, origin)`` pairs where
    origin is the file path or URL it was loaded from (used to rewrite
    relative url() values against ``css_out``). ``used`` is a set of class
    names (or a ClassPool); ``safelist`` entries are added to it.
    ``inline_rules`` (core.Rule objects) are emitted after the framework
    block, unlayered, and count as references for @keyframes / @font-face.
    """
    from .core import render_stylesheet

    pool = ClassPool()
    pool.update(used if isinstance(used, ClassPool) else set(used))
    pool.update(parse_safelist(safelist))

    sources: Sequence[Source] = [(css, source)] if isinstance(css, str) else css
    imports: list = []
    namespaces: list = []
    items: list = []
    kept = dropped = 0
    for text, origin in sources:
        ctx = _Ctx(pool, make_url_rewriter(origin, css_out), imports, namespaces)
        nodes = tinycss2.parse_stylesheet(text, skip_comments=False, skip_whitespace=True)
        items.extend(_prune(nodes, ctx, False, layer))
        kept += ctx.kept
        dropped += ctx.dropped

    items = _drop_empty(items)
    pruned = 0
    if not keep_all_at_rules:
        extra = [Decl(p, v) for r in inline_rules for p, v in r.decls.items()]
        items, pruned = prune_at_rules(items, extra)
        items = _drop_empty(items)

    head = namespaces_first(imports, namespaces)
    body: list = items
    if layer and _has_content(items):
        body = [AtRule("layer", LAYER_NAME, items)]
    elif layer:
        body = items  # only comments (or nothing): no point wrapping

    sep = "" if minify else "\n"
    chunks = []
    if head:
        chunks.append(render_tree(head, minify))
    if body:
        chunks.append(render_tree(body, minify))
    inline_css = render_stylesheet(list(inline_rules), minify, boost=boost).strip()
    if inline_css:
        chunks.append(inline_css)
    out = sep.join(chunks)
    if out and not minify:
        out += "\n"
    return ResolveResult(out, kept, dropped, pruned)


def namespaces_first(imports: list, namespaces: list) -> list:
    """@import rules must come first, then @namespace (CSS ordering rules)."""
    return list(imports) + list(namespaces)


def load_css_source(src: str, base_dir: str = ".", timeout: float = 30.0) -> Tuple[str, str]:
    """Load CSS from a file path (relative to base_dir) or an http(s) URL.
    Returns (text, origin) where origin is the absolute path or the URL."""
    if re.match(r"^https?://", src, re.I):
        req = urllib.request.Request(src, headers={"User-Agent": "inline2css"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.read().decode(charset, errors="replace"), src
    if src.startswith("//"):
        return load_css_source("https:" + src, base_dir, timeout)
    path = src if os.path.isabs(src) else os.path.join(base_dir, src)
    path = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
    with open(path, encoding="utf-8-sig") as fh:
        return fh.read(), os.path.abspath(path)


def href_basename(href: str) -> str:
    """Basename of a link href or source, with query string and fragment stripped."""
    clean = href.split("#", 1)[0].split("?", 1)[0]
    if re.match(r"^https?://", clean, re.I):
        clean = urllib.parse.urlparse(clean).path
    return posixpath.basename(clean.replace("\\", "/"))

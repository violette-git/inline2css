"""Core conversion logic for inline2css."""

from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from bs4 import BeautifulSoup
from bs4.builder import HTMLParserTreeBuilder
from bs4.dammit import EntitySubstitution
from bs4.element import Doctype
from bs4.formatter import HTMLFormatter


class _EveryTag(frozenset):
    def __contains__(self, item) -> bool:  # every tag preserves whitespace
        return True


def make_soup(html: str) -> BeautifulSoup:
    """Parse HTML without collapsing whitespace-only text nodes. BeautifulSoup
    normally shrinks them to one space or newline outside <pre>/<textarea>,
    which changes rendering under CSS white-space: pre / pre-wrap."""
    builder = HTMLParserTreeBuilder(preserve_whitespace_tags=_EveryTag())
    return BeautifulSoup(html, builder=builder)


def _substitute(text: str) -> str:
    # Minimal escaping (&, <, >) plus &nbsp;, which is invisible when raw.
    return EntitySubstitution.substitute_xml(text).replace("\xa0", "&nbsp;")


class _SourceOrderFormatter(HTMLFormatter):
    def attributes(self, tag):  # keep the author's attribute order
        return list(tag.attrs.items()) if tag.attrs else []


_FORMATTER = _SourceOrderFormatter(entity_substitution=_substitute, void_element_close_prefix="")


def serialize_soup(soup) -> str:
    """Serialize parsed HTML: attributes in source order, HTML5 void tags
    (``<br>``, not ``<br/>``) and non-breaking spaces kept as &nbsp;. The
    whitespace-preserving parser already keeps the source's own newline after
    the doctype, so BeautifulSoup's extra one is removed."""
    out = soup.decode(formatter=_FORMATTER)
    first = soup.contents[0] if soup.contents else None
    if isinstance(first, Doctype):
        head = f"<!DOCTYPE {first}>"
        if out.startswith(head + "\n"):
            out = head + out[len(head) + 1:]
    return out


@dataclass
class Rule:
    class_name: str
    decls: "OrderedDict[str, str]"
    key: str


@dataclass
class Registry:
    """Shared dedup registry (for directory / merge modes)."""

    by_key: "OrderedDict[str, Rule]" = field(default_factory=OrderedDict)
    counter: int = 0

    def size(self) -> int:
        return len(self.by_key)


def parse_declarations(style: str) -> "OrderedDict[str, str]":
    """Parse a style attribute into ordered prop:value pairs, tolerating
    missing semicolons, whitespace, quotes, and semicolons inside url(...)."""
    decls: "OrderedDict[str, str]" = OrderedDict()
    buf: List[str] = []
    depth = 0
    quote: Optional[str] = None
    pieces: List[str] = []

    for ch in str(style):
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == ";" and depth == 0:
            pieces.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        pieces.append("".join(buf))

    for piece in pieces:
        piece = piece.strip()
        if not piece or ":" not in piece:
            continue
        prop, _, value = piece.partition(":")
        prop = prop.strip().lower()
        value = value.strip()
        if prop and value:
            decls[prop] = value  # last-wins
    return decls


def canonical(decls: "OrderedDict[str, str]") -> str:
    return ";".join(f"{k}:{v}" for k, v in sorted(decls.items()))


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return s[:40]


def make_class_name(decls, key, naming, prefix, seq) -> str:
    if naming == "hash":
        h = hashlib.sha1(key.encode()).hexdigest()[:6]
        return f"{prefix}{h}"
    if naming == "semantic":
        first_prop = next(iter(decls))
        base = _slug(f"{first_prop}-{decls[first_prop]}")
        h = hashlib.sha1(key.encode()).hexdigest()[:4]
        return f"{prefix}{base or 'style'}-{h}"
    return f"{prefix}{seq}"


BOOST_SUFFIX = r":not(#\#)"


def render_rule(class_name, decls, minify=False, boost=False) -> str:
    """Render one rule. ``boost`` appends ``:not(#\\#)``, which adds one id
    worth of specificity so the rule beats framework class selectors."""
    selector = f".{class_name}{BOOST_SUFFIX if boost else ''}"
    if minify:
        body = ";".join(f"{p}:{v}" for p, v in decls.items())
        return f"{selector}{{{body}}}"
    body = "\n".join(f"    {p}: {v};" for p, v in decls.items())
    return f"{selector} {{\n{body}\n}}"


def render_stylesheet(rules: List[Rule], minify=False, boost=False) -> str:
    if not rules:
        return ""
    sep = "" if minify else "\n\n"
    css = sep.join(render_rule(r.class_name, r.decls, minify, boost) for r in rules)
    return css if minify else css + "\n"


def convert(
    html: str,
    *,
    prefix: str = "i2c-",
    naming: str = "sequential",
    css_href: str = "styles.css",
    inject_link: bool = True,
    registry: Optional[Registry] = None,
):
    """Convert an HTML string. Returns (new_html, rules_list)."""
    if registry is None:
        registry = Registry()

    soup = make_soup(html)
    touched = False

    for el in soup.find_all(style=True):
        decls = parse_declarations(el.get("style", ""))
        if not decls:
            del el["style"]
            touched = True
            continue

        key = canonical(decls)
        rule = registry.by_key.get(key)
        if rule is None:
            registry.counter += 1
            class_name = make_class_name(decls, key, naming, prefix, registry.counter)
            rule = Rule(class_name=class_name, decls=decls, key=key)
            registry.by_key[key] = rule

        existing = el.get("class", [])
        if rule.class_name not in existing:
            existing.append(rule.class_name)
        el["class"] = existing
        del el["style"]
        touched = True

    if touched and inject_link:
        head = soup.find("head")
        if head is None:
            head = soup.new_tag("head")
            html_tag = soup.find("html")
            (html_tag or soup).insert(0, head)
        if not head.find("link", href=css_href):
            head.append(soup.new_tag("link", rel="stylesheet", href=css_href))

    return serialize_soup(soup), list(registry.by_key.values())


def parse_existing_css(css: str) -> Registry:
    """Parse simple `.class { ... }` rules so a later run can reuse them."""
    registry = Registry()
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector = m.group(1).strip()
        if selector.endswith(BOOST_SUFFIX):
            selector = selector[: -len(BOOST_SUFFIX)]
        single = re.fullmatch(r"\.([A-Za-z_][-\w]*)", selector)
        if not single:
            continue
        decls = parse_declarations(m.group(2).strip())
        if not decls:
            continue
        key = canonical(decls)
        if key not in registry.by_key:
            registry.by_key[key] = Rule(single.group(1), decls, key)
    registry.counter = registry.size()
    return registry

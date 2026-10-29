"""Core conversion logic for inline2css."""

from __future__ import annotations

import hashlib
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from bs4 import BeautifulSoup


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


def render_rule(class_name, decls, minify=False) -> str:
    if minify:
        body = ";".join(f"{p}:{v}" for p, v in decls.items())
        return f".{class_name}{{{body}}}"
    body = "\n".join(f"    {p}: {v};" for p, v in decls.items())
    return f".{class_name} {{\n{body}\n}}"


def render_stylesheet(rules: List[Rule], minify=False) -> str:
    if not rules:
        return ""
    sep = "" if minify else "\n\n"
    css = sep.join(render_rule(r.class_name, r.decls, minify) for r in rules)
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

    soup = BeautifulSoup(html, "html.parser")
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

    return str(soup), list(registry.by_key.values())


def parse_existing_css(css: str) -> Registry:
    """Parse simple `.class { ... }` rules so a later run can reuse them."""
    registry = Registry()
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector = m.group(1).strip()
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

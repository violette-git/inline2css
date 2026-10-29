import functools
import http.server
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from inline2css import (  # noqa: E402
    BOOTSTRAP_SAFELIST,
    IMPORTANT_LAYER,
    LAYER_NAME,
    __version__,
    canonical,
    collect_used_classes,
    convert,
    convert_directory,
    convert_file,
    detect_bootstrap,
    parse_declarations,
    parse_existing_css,
    render_stylesheet,
    resolve_directory,
    resolve_file,
    resolve_stylesheet,
    selector_is_used,
)
from inline2css.cli import main as cli_main  # noqa: E402


def _tmp():
    return tempfile.mkdtemp(prefix="i2c-test-")


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _resolve(css, classes, **kw):
    """Resolve without the layer wrapper so assertions stay simple."""
    kw.setdefault("layer", False)
    return resolve_stylesheet(css, set(classes), **kw)


def _cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = cli_main(list(argv))
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# Existing inline extraction behavior
# ---------------------------------------------------------------------------


def test_basic_split():
    assert list(parse_declarations("color:blue; padding: 3px;").items()) == [
        ("color", "blue"),
        ("padding", "3px"),
    ]


def test_missing_semicolon():
    assert dict(parse_declarations("color:red")) == {"color": "red"}


def test_url_semicolons():
    d = parse_declarations("background-image: url(a.png; b.png); color: red")
    assert d["background-image"] == "url(a.png; b.png)"
    assert d["color"] == "red"


def test_quoted_semicolons():
    d = parse_declarations("content: 'a;b'; color: red")
    assert d["content"] == "'a;b'" and d["color"] == "red"


def test_empty_style():
    assert dict(parse_declarations("   ")) == {}


def test_last_wins():
    assert dict(parse_declarations("color:red;color:blue")) == {"color": "blue"}


def test_canonical_order_independent():
    a = parse_declarations("color:red;padding:1px")
    b = parse_declarations("padding:1px;color:red")
    assert canonical(a) == canonical(b)


def test_dedup():
    html = '<p style="color:blue">x</p><p style="color: blue;">y</p>'
    _, rules = convert(html)
    assert len(rules) == 1


def test_preserve_class():
    out, _ = convert('<div class="row" style="color:blue">x</div>')
    assert 'class="row i2c-1"' in out
    assert "style=" not in out


def test_whitespace_preserved():
    html = '<div style="white-space:pre"><i>a</i>    <i>b</i></div>\n  <p style="color:red">x</p>'
    out, _ = convert(html, inject_link=False)
    assert "<i>a</i>    <i>b</i>" in out and "\n  <p" in out


def test_html_serialization_stays_close_to_source():
    html = ('<!DOCTYPE html><html><head><meta name="viewport" content="x"></head><body>'
            '<p id="a" style="color:red" data-x="1">a&hellip; &nbsp;b &amp; c<br></p></body></html>')
    out, _ = convert(html)
    assert '<p id="a" data-x="1" class="i2c-1">' in out
    assert '<meta name="viewport" content="x">' in out and "<br>" in out and "/>" not in out
    assert "a\u2026 &nbsp;b &amp; c" in out
    assert out.startswith("<!DOCTYPE html><html>")
    out, _ = convert("<!DOCTYPE html>\n<html><body><p style='a:b'>x</p></body></html>", inject_link=False)
    assert out.startswith("<!DOCTYPE html>\n<html>")


def test_link_injected():
    out, _ = convert(
        '<html><head></head><body><p style="color:red">x</p></body></html>'
    )
    assert 'href="styles.css"' in out


def test_hash_naming():
    a = convert('<p style="color:red">x</p>', naming="hash")[1][0].class_name
    b = convert('<p style="color:red">y</p>', naming="hash")[1][0].class_name
    assert a == b and a.startswith("i2c-")
    assert re.fullmatch(r"i2c-[0-9a-f]{6}", a)


def test_semantic_naming():
    cls = convert('<p style="color:red">x</p>', naming="semantic")[1][0].class_name
    assert re.fullmatch(r"i2c-color-red-[0-9a-f]{4}", cls)


def test_custom_prefix():
    cls = convert('<p style="color:red">x</p>', prefix="x-")[1][0].class_name
    assert cls == "x-1"


def test_minify():
    _, rules = convert('<p style="color:red;padding:1px">x</p>')
    assert render_stylesheet(rules, True) == ".i2c-1{color:red;padding:1px}"


def test_parse_existing_css():
    reg = parse_existing_css(".foo{color:red}\n.bar{padding:1px}")
    assert reg.size() == 2


def test_merge_reuses_class():
    reg = parse_existing_css(".brand{color:red}")
    out, _ = convert('<p style="color:red">x</p>', registry=reg)
    assert 'class="brand"' in out


def test_convert_file():
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, '<body><p style="color:red">x</p></body>')
    r = convert_file(p)
    assert os.path.exists(r.css_path) and os.path.exists(r.html_path)
    assert "style=" not in _read(r.html_path)


def test_dry_run():
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, '<body><p style="color:red">x</p></body>')
    r = convert_file(p, dry_run=True)
    assert not os.path.exists(r.css_path)
    assert not os.path.exists(r.html_path)
    assert r.wrote is False


def test_in_place():
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, '<body><p style="color:red">x</p></body>')
    r = convert_file(p, in_place=True)
    assert r.html_path == p and "style=" not in _read(p)


def test_convert_directory_shared():
    d = _tmp()
    for name in ("a.html", "b.html"):
        _write(os.path.join(d, name), '<body><p style="color:red">x</p></body>')
    r = convert_directory(d)
    assert r.rule_count == 1
    assert len(r.html_paths) == 2


def test_convert_directory_skips_node_modules_and_dotdirs():
    d = _tmp()
    _write(os.path.join(d, "a.html"), '<p style="color:red">x</p>')
    _write(os.path.join(d, "node_modules", "x.html"), '<p style="color:blue">x</p>')
    _write(os.path.join(d, ".git", "y.html"), '<p style="color:green">x</p>')
    r = convert_directory(d)
    assert r.rule_count == 1 and len(r.html_paths) == 1


# ---------------------------------------------------------------------------
# Resolve basics (kept behavior)
# ---------------------------------------------------------------------------


def test_resolve_keeps_used_drops_unused():
    r = _resolve(".a{color:red}.b{color:blue}", {"a"})
    assert ".a {" in r.css and ".b" not in r.css
    assert r.kept_rules == 1 and r.dropped_rules == 1


def test_resolve_descendant_needs_all_classes():
    assert _resolve(".a .b{color:red}", {"a"}).css.strip() == ""
    assert ".a .b" in _resolve(".a .b{color:red}", {"a", "b"}).css


def test_resolve_keeps_pseudo_state():
    assert ".btn:hover" in _resolve(".btn:hover{color:red}", {"btn"}).css


def test_resolve_media_pruned_inside():
    css = "@media (min-width:1px){.a{color:red}.b{color:blue}}"
    out = _resolve(css, {"a"}).css
    assert "@media (min-width:1px)" in out and ".a" in out and ".b" not in out


def test_resolve_drops_empty_media():
    assert "@media" not in _resolve("@media (x){.b{color:blue}}", {"a"}).css


def test_resolve_keeps_element_selectors():
    out = _resolve("body{margin:0}:root{--x:1}*{box-sizing:border-box}a:hover{color:red}[hidden]{display:none}", set()).css
    for sel in ("body", ":root", "*", "a:hover", "[hidden]"):
        assert sel + " {" in out, sel


def test_resolve_escaped_colon():
    assert r".md\:flex" in _resolve(r".md\:flex{display:flex}", {"md:flex"}).css


def test_resolve_escaped_brackets():
    assert r".p-\[13px\]" in _resolve(r".p-\[13px\]{padding:13px}", {"p-[13px]"}).css
    assert r".w-1\/3" in _resolve(r".w-1\/3{width:33%}", {"w-1/3"}).css


def test_resolve_hex_escape():
    assert _resolve(r".\31 0{color:red}", {"10"}).css.strip() != ""
    assert _resolve(r".md\3A flex{color:red}", {"md:flex"}).css.strip() != ""


def test_collect_used_classes():
    used = collect_used_classes('<div class="a  b"><p class="c">x</p></div>')
    assert used == {"a", "b", "c"}


# ---------------------------------------------------------------------------
# 1. Selector matching
# ---------------------------------------------------------------------------


def test_not_classes_are_ignored():
    assert selector_is_used(":not(.btn-check)+.btn:active", {"btn"})
    assert not selector_is_used(":not(.btn-check)+.btn:active", {"other"})
    css = ".btn-check:checked+.btn,:not(.btn-check)+.btn:active{color:red}"
    out = _resolve(css, {"btn"}).css
    assert ":not(.btn-check)+.btn:active" in out and ".btn-check:checked" not in out


def test_is_where_any_branch():
    assert selector_is_used(":where(.space-y-2 > :not(:last-child))", {"space-y-2"})
    assert not selector_is_used(":where(.space-y-2 > :not(:last-child))", {"x"})
    assert selector_is_used(":is(.a,.b) .c", {"b", "c"})
    assert not selector_is_used(":is(.a,.b) .c", {"c"})
    for fn in ("matches", "-webkit-any", "-moz-any"):
        assert selector_is_used(f":{fn}(.a,.b)", {"a"})
        assert not selector_is_used(f":{fn}(.a,.b)", {"z"})


def test_has_any_branch():
    assert selector_is_used(".card:has(.x, .y)", {"card", "y"})
    assert not selector_is_used(".card:has(.x, .y)", {"card"})


def test_nested_functional_pseudos():
    assert selector_is_used(":is(:where(.a), .b):not(.c)", {"a"})
    assert not selector_is_used(":is(:where(.a), .b)", {"c"})


def test_other_functional_pseudos_are_conservative():
    assert selector_is_used("li:nth-child(2n of .x)", set())
    assert selector_is_used(":host(.x)", set())
    assert selector_is_used(".a::part(foo)", {"a"})
    assert selector_is_used("::slotted(.x)", set())


def test_selector_list_keeps_only_satisfiable():
    out = _resolve(".a,.b,.c{color:red}", {"a", "c"}).css
    assert out.startswith(".a, .c {")


def test_tailwind_where_rule_kept():
    css = ":where(.space-y-2 > :not(:last-child)){margin-block-start:8px}"
    assert "space-y-2" in _resolve(css, {"space-y-2"}).css


def test_nested_style_rules_and_layers_walked():
    css = "@layer a{@layer b{@supports (x:y){@container (min-width:1px){.used{color:red}.unused{color:blue}}}}}"
    out = _resolve(css, {"used"}).css
    assert ".used" in out and ".unused" not in out and "@container" in out
    assert "@layer a" in out and "@layer b" in out


def test_css_nesting_children_pruned():
    css = ".a{color:red;.b{color:blue}&:hover{color:green}}"
    out = _resolve(css, {"a"}).css
    assert "&:hover" in out and ".b" not in out
    assert "color: red" in out


def test_empty_named_layer_becomes_statement():
    out = _resolve("@layer components{.x{color:red}}", set()).css
    assert out.strip() == "@layer components;"


# ---------------------------------------------------------------------------
# 2. Safelist
# ---------------------------------------------------------------------------


def test_safelist_name():
    css = ".show{display:block}.other{color:red}"
    out = _resolve(css, set(), safelist=["show"]).css
    assert ".show" in out and ".other" not in out


def test_safelist_regex():
    css = ".tooltip{a:b}.tooltip-inner{a:b}.nope{a:b}"
    out = _resolve(css, set(), safelist=["/^tooltip/"]).css
    assert ".tooltip-inner" in out and ".nope" not in out
    out = _resolve(css, set(), safelist=[re.compile("inner$")]).css
    assert ".tooltip-inner" in out and ".tooltip {" not in out


def test_bootstrap_preset_contents():
    for name in ("show", "collapsing", "modal-backdrop", "toast", "dropdown-menu-end", "was-validated"):
        assert name in BOOTSTRAP_SAFELIST
    assert "/^bs-tooltip-/" in BOOTSTRAP_SAFELIST and "/^bs-popover-/" in BOOTSTRAP_SAFELIST


def test_detect_bootstrap():
    assert detect_bootstrap('<script src="js/bootstrap.bundle.min.js"></script>')
    assert detect_bootstrap('<script src="BOOTSTRAP.JS"></script>')
    assert detect_bootstrap('<button data-bs-toggle="modal">x</button>')
    assert not detect_bootstrap('<script src="app.js"></script><div class="x">x</div>')


def _bootstrap_page(d, extra=""):
    _write(os.path.join(d, "fw.css"), ".modal{display:none}.modal.show{display:block}.bs-tooltip-top{a:b}.nope{a:b}")
    page = os.path.join(d, "page.html")
    _write(page, f'<html><head><link rel="stylesheet" href="fw.css"></head><body><div class="modal" {extra}>x</div></body></html>')
    return page


def test_auto_safelist_applies_preset():
    d = _tmp()
    page = _bootstrap_page(d, 'data-bs-backdrop="static"')
    r = resolve_file(page, resolve_linked=True, layer=False)
    css = _read(r.css_path)
    assert r.auto_safelist and r.notes and ".modal.show" in css and ".bs-tooltip-top" in css
    assert ".nope" not in css


def test_no_auto_safelist():
    d = _tmp()
    page = _bootstrap_page(d, 'data-bs-backdrop="static"')
    r = resolve_file(page, resolve_linked=True, layer=False, auto_safelist=False)
    assert not r.auto_safelist and ".modal.show" not in _read(r.css_path)


def test_explicit_preset_without_detection():
    d = _tmp()
    page = _bootstrap_page(d)
    r = resolve_file(page, resolve_linked=True, safelist_preset="bootstrap")
    assert ".modal.show" in _read(r.css_path) and not r.auto_safelist


def test_cli_auto_safelist_note_printed_once():
    d = _tmp()
    page = _bootstrap_page(d, 'data-bs-toggle="x"')
    code, out, err = _cli(page, "--resolve-linked")
    assert code == 0 and err.count("note:") == 1 and "note:" not in out


# ---------------------------------------------------------------------------
# 3. Precedence: @layer wrapping, hoisting, --boost
# ---------------------------------------------------------------------------


def test_layer_wraps_framework_and_inline_after():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".navbar-nav .nav-link{padding:8px}")
    page = os.path.join(d, "page.html")
    _write(page, '<html><head><link rel="stylesheet" href="fw.css"></head><body><ul class="navbar-nav">'
                 '<a class="nav-link" style="padding:0 40px">x</a></ul></body></html>')
    r = resolve_file(page, resolve_linked=True)
    css = _read(r.css_path)
    assert css.startswith(f"@layer {LAYER_NAME} {{")
    layer_end = css.index("\n}\n")
    assert css.index(".i2c-1") > layer_end
    assert ".navbar-nav .nav-link" in css[:layer_end]


def test_no_layer():
    out = resolve_stylesheet(".a{color:red}", {"a"}, layer=False).css
    assert "@layer" not in out


def test_layer_hoists_import_namespace_drops_charset():
    css = ('@charset "UTF-8";@import url(base.css) screen;@import "x.css";'
           '@namespace svg url(http://www.w3.org/2000/svg);.a{color:red}')
    out = resolve_stylesheet(css, {"a"}).css
    assert "@charset" not in out
    lines = out.splitlines()
    assert lines[0] == f'@import url("base.css") layer({LAYER_NAME}) screen;'
    assert lines[1] == f'@import url("x.css") layer({LAYER_NAME});'
    assert lines[2].startswith("@namespace svg")
    assert lines[3] == f"@layer {LAYER_NAME} {{"


def test_import_without_layer_keeps_url():
    out = resolve_stylesheet('@import "x.css" print;.a{b:c}', {"a"}, layer=False).css
    assert out.splitlines()[0] == '@import url("x.css") print;'


def test_framework_important_survives_in_layer():
    out = resolve_stylesheet(".a{color:red!important}", {"a"}).css
    assert "color: red !important;" in out


def _important_page(style, minify=False, layer=True, boost=False):
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:blue!important;margin:0}")
    p = os.path.join(d, "page.html")
    _write(p, f'<link rel="stylesheet" href="fw.css"><p class="a" style="{style}">x</p>'
              '<p style="margin:1px!important">y</p>')
    return _read(resolve_file(p, resolve_linked=True, minify=minify, layer=layer, boost=boost).css_path)


def test_inline_important_goes_to_important_layer():
    css = _important_page("color:red !important;padding:2px")
    assert css == (
        f"@layer {IMPORTANT_LAYER},{LAYER_NAME};\n"
        f"@layer {LAYER_NAME} {{\n    .a {{\n        color: blue !important;\n        margin: 0;\n    }}\n}}\n\n"
        ".i2c-1 {\n    padding: 2px;\n}\n\n"
        f"@layer {IMPORTANT_LAYER} {{\n    .i2c-1 {{\n        color: red !important;\n    }}\n"
        "    .i2c-2 {\n        margin: 1px !important;\n    }\n}\n"
    )


def test_inline_important_minified_and_boosted():
    css = _important_page("color:red !important;padding:2px", minify=True, boost=True)
    assert css == (
        f"@layer {IMPORTANT_LAYER},{LAYER_NAME};@layer {LAYER_NAME}{{.a{{color:blue!important;margin:0}}}}"
        r".i2c-1:not(#\#){padding:2px}"
        f"@layer {IMPORTANT_LAYER}{{" r".i2c-1:not(#\#){color:red!important}.i2c-2:not(#\#){margin:1px!important}}"
    )


def test_no_important_layer_without_inline_important():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:blue!important}")
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="fw.css"><p class="a" style="padding:2px">x</p>')
    css = _read(resolve_file(p, resolve_linked=True).css_path)
    assert IMPORTANT_LAYER not in css and css.startswith(f"@layer {LAYER_NAME} {{")


def test_inline_important_unlayered_with_no_layer():
    css = _important_page("color:red !important;padding:2px", layer=False)
    assert "@layer" not in css and "color: red !important;" in css


def test_boost_basic_mode():
    _, rules = convert('<p style="color:red">x</p>')
    assert render_stylesheet(rules, True, boost=True) == r".i2c-1:not(#\#){color:red}"
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, '<p style="color:red">x</p>')
    r = convert_file(p, boost=True)
    assert r".i2c-1:not(#\#) {" in _read(r.css_path)


def test_boost_round_trips_through_merge():
    reg = parse_existing_css(".i2c-1:not(#\\#){color:red}")
    assert reg.size() == 1


def test_boost_resolve_mode():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:blue}")
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="fw.css"><p class="a" style="color:red">x</p>')
    r = resolve_file(p, resolve_linked=True, boost=True)
    assert r".i2c-1:not(#\#)" in _read(r.css_path)


# ---------------------------------------------------------------------------
# 4. Dead at-rule pruning
# ---------------------------------------------------------------------------

_AT = ("@keyframes spin{to{transform:rotate(1turn)}}@keyframes fade{to{opacity:0}}"
       "@font-face{font-family:\"Open Sans\";src:url(o.woff)}@font-face{font-family:Unused;src:url(u.woff)}")


def test_keyframes_pruned_unless_referenced():
    out = _resolve(_AT + ".a{animation:spin 1s linear infinite}", {"a"}).css
    assert "@keyframes spin" in out and "@keyframes fade" not in out
    out = _resolve(_AT + ".a{animation-name:fade}", {"a"}).css
    assert "@keyframes fade" in out and "@keyframes spin" not in out


def test_keyframes_referenced_via_custom_property():
    kf = "@keyframes pulse{50%{opacity:.5}}:root{--animate-pulse:pulse 2s infinite}"
    out = _resolve(kf + ".a{animation:var(--animate-pulse)}", {"a"}).css
    assert "@keyframes pulse" in out
    # A custom property nothing uses through var() is not a reference.
    assert "@keyframes" not in _resolve(kf, set()).css


def test_font_face_referenced_through_var_chain():
    css = ("@font-face{font-family:Brand;src:url(b.woff)}@font-face{font-family:Other;src:url(o.woff)}"
           ":root{--f1:var(--f2);--f2:Brand, sans-serif;--unused:Other}body{font-family:var(--f1)}")
    out = _resolve(css, set()).css
    assert "b.woff" in out and "o.woff" not in out


def test_keyframes_referenced_by_dropped_rule_are_pruned():
    out = _resolve(_AT + ".unused{animation:spin 1s}", {"a"}).css
    assert "@keyframes" not in out


def test_font_face_pruned_unless_referenced():
    out = _resolve(_AT + ".a{font:bold 1rem 'Open Sans', sans-serif}", {"a"}).css
    assert "Open Sans" in out and "Unused" not in out
    out = _resolve(_AT + ".a{font-family:Open Sans}", {"a"}).css
    assert "o.woff" in out and "u.woff" not in out


def test_inline_rules_count_as_references():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), "@keyframes spin{to{opacity:0}}")
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="fw.css"><p style="animation:spin 1s">x</p>')
    assert "@keyframes spin" in _read(resolve_file(p, resolve_linked=True).css_path)


def test_keep_all_at_rules():
    out = _resolve(_AT, set(), keep_all_at_rules=True).css
    assert "@keyframes spin" in out and "@keyframes fade" in out and "Unused" in out


def test_old_keep_at_rules_flags_removed():
    code, _, err = _cli("x.html", "--no-keep-at-rules")
    assert code == 2 and "unknown option" in err


# ---------------------------------------------------------------------------
# 5. url() rewriting
# ---------------------------------------------------------------------------

_URL_CSS = ('.a{background:url(img/a.png);mask:url("../m.svg#x");'
            "b1:url(data:image/png;base64,AA);b2:url(https://x.test/y.png);"
            "b3:url(//cdn.test/z.png);b4:url(/abs.png);b5:url(#frag);"
            'b6:image-set("img/1x.png" 1x)}')


def test_url_rewrite_local_different_dir():
    d = _tmp()
    src = os.path.join(d, "vendor", "css", "fw.css")
    _write(src, _URL_CSS)
    out = resolve_stylesheet(_read(src), {"a"}, source=src, css_out=os.path.join(d, "site", "styles.css"), layer=False).css
    assert 'url("../vendor/css/img/a.png")' in out
    assert 'url("../vendor/m.svg#x")' in out
    for keep in ("url(data:image/png;base64,AA)", "url(https://x.test/y.png)", "url(//cdn.test/z.png)",
                 "url(/abs.png)", "url(#frag)"):
        assert keep in out, keep
    assert '"../vendor/css/img/1x.png" 1x' in out


def test_url_rewrite_same_dir_untouched():
    d = _tmp()
    src = os.path.join(d, "fw.css")
    out = resolve_stylesheet(_URL_CSS, {"a"}, source=src, css_out=os.path.join(d, "styles.css"), layer=False).css
    assert "url(img/a.png)" in out


def test_url_rewrite_http_source_absolute():
    out = resolve_stylesheet(_URL_CSS, {"a"}, source="https://cdn.test/lib/css/fw.css", layer=False).css
    assert 'url("https://cdn.test/lib/css/img/a.png")' in out
    assert 'url("https://cdn.test/lib/m.svg#x")' in out
    assert "url(data:image/png;base64,AA)" in out


def test_url_rewrite_through_resolve_file():
    d = _tmp()
    _write(os.path.join(d, "assets", "fw.css"), ".a{background:url(bg.png)}")
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="assets/fw.css"><p class="a">x</p>')
    r = resolve_file(p, resolve_linked=True)
    assert 'url("assets/bg.png")' in _read(r.css_path)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def test_http_source_fetch():
    d = _tmp()
    _write(os.path.join(d, "srv", "css", "fw.css"), ".a{background:url(i.png)}.b{color:red}")
    handler = functools.partial(_Quiet, directory=os.path.join(d, "srv"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/css/fw.css"
        p = os.path.join(d, "page.html")
        _write(p, f'<html><head><link rel="stylesheet" href="{url}?v=3"></head><body><p class="a">x</p></body></html>')
        r = resolve_file(p, resolve=[url])
        css = _read(r.css_path)
        assert f'url("{url[:-6]}i.png")' in css and ".b" not in css
        html = _read(r.html_path)
        assert url not in html and 'href="styles.css"' in html
    finally:
        server.shutdown()


# ---------------------------------------------------------------------------
# 6. Link removal (regression)
# ---------------------------------------------------------------------------


def _links(html):
    return re.findall(r'<link[^>]*href="([^"]+)"', html)


def test_link_removal_resolve_linked():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:red}")
    _write(os.path.join(d, "theme.css"), ".b{color:blue}")
    p = os.path.join(d, "page.html")
    _write(p, '<html><head><link rel="stylesheet" href="fw.css"><link rel="stylesheet" href="theme.css">'
              '<link rel="icon" href="f.ico"></head><body><p class="a b">x</p></body></html>')
    r = resolve_file(p, resolve_linked=True)
    assert _links(_read(r.html_path)) == ["f.ico", "styles.css"]
    css = _read(r.css_path)
    assert ".a" in css and ".b" in css


def test_link_removal_explicit_basename_query_stripped():
    d = _tmp()
    _write(os.path.join(d, "vendor", "bootstrap.min.css"), ".a{color:red}")
    p = os.path.join(d, "site", "page.html")
    _write(p, '<html><head><link rel="stylesheet" href="https://cdn.test/x/bootstrap.min.css?v=5">'
              '<link rel="stylesheet" href="mine.css"></head><body><p class="a">x</p></body></html>')
    r = resolve_file(p, resolve=[os.path.join(d, "vendor", "bootstrap.min.css")])
    assert _links(_read(r.html_path)) == ["mine.css", "styles.css"]


def test_link_not_duplicated_when_output_already_linked():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:red}")
    p = os.path.join(d, "page.html")
    _write(p, '<html><head><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fw.css">'
              '</head><body><p class="a">x</p></body></html>')
    r = resolve_file(p, resolve=[os.path.join(d, "fw.css")])
    assert _links(_read(r.html_path)) == ["styles.css"]


# ---------------------------------------------------------------------------
# 7. Resolve on a directory
# ---------------------------------------------------------------------------


def test_resolve_directory():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:red}.b{color:blue}.c{color:green}.safe{x:y}")
    _write(os.path.join(d, "site", "index.html"),
           '<html><head><link rel="stylesheet" href="../fw.css"></head><body><p class="a" style="margin:1px">x</p></body></html>')
    _write(os.path.join(d, "site", "sub", "about.html"),
           '<html><head><link rel="stylesheet" href="../../fw.css"></head><body><p class="b" style="margin: 1px">x</p></body></html>')
    _write(os.path.join(d, "site", "node_modules", "n.html"), '<p class="c">x</p>')
    _write(os.path.join(d, "site", ".hidden", "h.html"), '<p class="c">x</p>')
    r = resolve_directory(os.path.join(d, "site"), resolve_linked=True, safelist=["safe"], layer=False)
    css = _read(r.css_path)
    assert ".a" in css and ".b" in css and ".safe" in css and ".c" not in css
    assert r.inline_rules == 1 and css.count(".i2c-1") == 1 and ".i2c-2" not in css
    assert len(r.html_paths) == 2
    idx = _read(os.path.join(d, "site", "index.cleaned.html"))
    about = _read(os.path.join(d, "site", "sub", "about.cleaned.html"))
    assert _links(idx) == ["styles.css"] and _links(about) == ["../styles.css"]
    assert 'class="b i2c-1"' in about


def test_resolve_directory_cli():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:red}")
    _write(os.path.join(d, "s", "a.html"), '<link rel="stylesheet" href="fw.css"><p class="a">x</p>')
    code, out, _ = _cli(os.path.join(d, "s"), "--resolve", os.path.join(d, "fw.css"))
    assert code == 0 and "1 HTML file(s)" in out
    assert _links(_read(os.path.join(d, "s", "a.cleaned.html"))) == ["styles.css"]


# ---------------------------------------------------------------------------
# 8. Safe pretty printer
# ---------------------------------------------------------------------------


def test_pretty_printer_keeps_strings_and_urls_intact():
    css = (".a{--img:url(\"data:image/svg+xml,%3csvg viewBox='0 0 16 16'%3e%3cpath d='M1 1;{}'/%3e%3c/svg%3e\");"
           "content:\"a;b{c}\";background:url(data:x;y{z});width:calc((1px + 2px) * 3)}")
    out = _resolve(css, {"a"}).css
    lines = out.splitlines()
    assert lines[0] == ".a {"
    assert any("%3cpath d='M1 1;{}'/%3e" in line for line in lines)
    assert any('content: "a;b{c}";' in line for line in lines)
    assert any("url(data:x;y{z})" in line for line in lines)
    assert any("calc((1px + 2px) * 3)" in line for line in lines)
    assert len(lines) == 6


def test_minified_resolve():
    out = resolve_stylesheet("@media (x){.a{color:red;margin:0}}", {"a"}, minify=True).css
    assert out == f"@layer {LAYER_NAME}{{@media (x){{.a{{color:red;margin:0}}}}}}"


def test_license_comments_kept():
    out = _resolve("/*! keep me */ /* drop me */ .a{color:red}", {"a"}).css
    assert "keep me" in out and "drop me" not in out


# ---------------------------------------------------------------------------
# 9. CLI polish
# ---------------------------------------------------------------------------


def test_cli_version():
    for flag in ("--version", "-v"):
        code, out, _ = _cli(flag)
        assert code == 0 and out.strip() == __version__
    assert __version__ == "1.1.0"


def test_cli_help_lists_flags():
    code, out, _ = _cli("--help")
    assert code == 0
    for flag in ("--css", "--html-out", "--naming", "--prefix", "--minify", "--merge", "--in-place",
                 "--dry-run", "--resolve", "--resolve-linked", "--safelist", "--safelist-preset",
                 "--no-auto-safelist", "--no-layer", "--boost", "--keep-all-at-rules", "--version"):
        assert flag in out, flag
    assert "\u2014" not in out


def test_cli_unknown_flag():
    code, _, err = _cli("page.html", "--bogus")
    assert code == 2 and "unknown option" in err and "--bogus" in err


def test_cli_missing_input_exit_1():
    assert _cli()[0] == 1
    assert _cli("/definitely/not/here.html")[0] == 1


def test_cli_safelist_without_resolve_notes():
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, '<p style="color:red">x</p>')
    code, _, err = _cli(p, "--safelist", "x", "--safelist-preset", "bootstrap")
    assert code == 0
    assert "note: --safelist only applies" in err and "note: --safelist-preset only applies" in err


def test_keep_element_selectors_false():
    out = resolve_stylesheet("body{margin:0}.a{color:red}", {"a"}, layer=False,
                             keep_element_selectors=False).css
    assert "body" not in out and ".a" in out


def test_cli_resolve_dry_run_writes_nothing():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), ".a{color:red}")
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="fw.css"><p class="a">x</p>')
    code, out, _ = _cli(p, "--resolve-linked", "--dry-run")
    assert code == 0 and "Would write" in out
    assert not os.path.exists(os.path.join(d, "styles.css"))


def test_cli_missing_resolve_source_exit_1():
    d = _tmp()
    p = os.path.join(d, "page.html")
    _write(p, "<p>x</p>")
    code, _, err = _cli(p, "--resolve", os.path.join(d, "nope.css"))
    assert code == 1 and "Could not load" in err


def test_cli_module_entrypoint():
    src = os.path.join(os.path.dirname(__file__), "..", "src")
    env = dict(os.environ, PYTHONPATH=os.path.abspath(src))
    res = subprocess.run([sys.executable, "-m", "inline2css.cli", "--version"],
                         capture_output=True, text=True, env=env)
    assert res.returncode == 0 and "1.1.0" in res.stdout


# ---------------------------------------------------------------------------
# 10. Output order
# ---------------------------------------------------------------------------


def test_output_order():
    d = _tmp()
    _write(os.path.join(d, "fw.css"), '@charset "UTF-8";.a{color:red}@namespace url(x);@import "y.css";')
    p = os.path.join(d, "page.html")
    _write(p, '<link rel="stylesheet" href="fw.css"><p class="a" style="color:blue">x</p>')
    css = _read(resolve_file(p, resolve_linked=True).css_path)
    i_imp, i_ns = css.index("@import"), css.index("@namespace")
    i_layer, i_inline = css.index(f"@layer {LAYER_NAME}"), css.index(".i2c-1")
    assert i_imp < i_ns < i_layer < i_inline


# ---------------------------------------------------------------------------
# Runner (python tests/test_core.py)
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    fns = {k: v for k, v in globals().items() if k.startswith("test_") and callable(v)}
    failed = 0
    for name, fn in fns.items():
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)

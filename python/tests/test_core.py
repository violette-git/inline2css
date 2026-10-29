import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from inline2css import (  # noqa: E402
    canonical,
    convert,
    convert_directory,
    convert_file,
    parse_declarations,
    parse_existing_css,
    render_stylesheet,
)


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


def test_link_injected():
    out, _ = convert(
        '<html><head></head><body><p style="color:red">x</p></body></html>'
    )
    assert 'href="styles.css"' in out


def test_hash_naming():
    a = convert('<p style="color:red">x</p>', naming="hash")[1][0].class_name
    b = convert('<p style="color:red">y</p>', naming="hash")[1][0].class_name
    assert a == b and a.startswith("i2c-")


def test_semantic_naming():
    cls = convert('<p style="color:red">x</p>', naming="semantic")[1][0].class_name
    assert cls.startswith("i2c-color-red-")


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
    d = tempfile.mkdtemp()
    p = os.path.join(d, "page.html")
    with open(p, "w") as fh:
        fh.write('<body><p style="color:red">x</p></body>')
    r = convert_file(p)
    assert os.path.exists(r.css_path) and os.path.exists(r.html_path)
    with open(r.html_path) as fh:
        assert "style=" not in fh.read()


def test_dry_run():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "page.html")
    with open(p, "w") as fh:
        fh.write('<body><p style="color:red">x</p></body>')
    r = convert_file(p, dry_run=True)
    assert not os.path.exists(r.css_path)
    assert r.wrote is False


def test_convert_directory_shared():
    d = tempfile.mkdtemp()
    for name in ("a.html", "b.html"):
        with open(os.path.join(d, name), "w") as fh:
            fh.write('<body><p style="color:red">x</p></body>')
    r = convert_directory(d)
    assert r.rule_count == 1
    assert len(r.html_paths) == 2


if __name__ == "__main__":
    fns = {k: v for k, v in sorted(globals().items()) if k.startswith("test_")}
    failed = 0
    for name, fn in fns.items():
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e}")
    sys.exit(1 if failed else 0)

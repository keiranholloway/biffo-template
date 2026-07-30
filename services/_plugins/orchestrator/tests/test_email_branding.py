"""Tests for the shared branded HTML email layout (email_branding.py).

Covers what issue tabsii-platform#378 explicitly calls out as insufficient
("a test asserting the payload contains an Html key proves nothing"): real
parse-and-check of the produced HTML, that branding config actually reaches
the output, safe escaping of payload-templated content, and the plain-text/
HTML paragraph conversion.

NOT covered here, and explicitly not claimed anywhere in this PR: rendering
in a real inbox (Gmail, Outlook, Apple Mail, light/dark). See the PR body.
"""

from __future__ import annotations

from html.parser import HTMLParser

from orchestrator.email_branding import (
    EmailBranding,
    build_source,
    build_subject,
    render_email_html,
)

# Void elements never need a matching close tag (HTML5's rules) — a balance
# checker that doesn't know this would wrongly flag every <img>/<meta>/<br>.
_VOID_ELEMENTS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)


class _BalanceCheckingParser(HTMLParser):
    """A real parse-and-check: every non-void start tag must have a matching
    end tag, properly nested, and the parser itself must raise no error.

    This is deliberately stricter than "does html.parser choke on it" —
    ``HTMLParser`` is lenient by design and will happily parse garbage. The
    stack-based nesting check is what actually proves the markup is
    well-formed, which is the bar issue #378 sets ("a parse-and-check, not
    just 'contains an Html key'").
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in _VOID_ELEMENTS:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_ELEMENTS:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"unbalanced </{tag}> (stack: {self.stack})")
            return
        self.stack.pop()


def _assert_well_formed_html(document: str) -> None:
    parser = _BalanceCheckingParser()
    parser.feed(document)
    parser.close()
    assert parser.errors == [], f"malformed HTML: {parser.errors}"
    assert parser.stack == [], f"unclosed tags at end of document: {parser.stack}"


# ── Well-formedness ──────────────────────────────────────────────────────────


def test_default_branding_renders_well_formed_html():
    html_doc = render_email_html(EmailBranding(), subject="Hello", text_body="Hi there.")
    _assert_well_formed_html(html_doc)
    assert html_doc.startswith("<!doctype html>")


def test_fully_configured_branding_renders_well_formed_html():
    branding = EmailBranding(
        company_name="Acme Co",
        logo_url="https://assets.example.com/logo.png",
        logo_alt="Acme Co logo",
        primary_color="#003366",
        background_color="#eeeeee",
        footer_text="Acme Co, 1 Main St",
        footer_links=(
            ("Privacy", "https://example.com/privacy"),
            ("Unsubscribe", "https://example.com/u"),
        ),
        from_name="Acme Notifications",
        subject_prefix="[Acme] ",
    )
    html_doc = render_email_html(
        branding, subject="[Acme] New lead", text_body="Line one.\n\nLine two."
    )
    _assert_well_formed_html(html_doc)


def test_empty_body_still_renders_well_formed_html():
    html_doc = render_email_html(EmailBranding(), subject="Empty", text_body="")
    _assert_well_formed_html(html_doc)


# ── Real-client-rendering structural requirements ────────────────────────────


def test_uses_table_based_layout():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    assert html_doc.count("<table") >= 2  # outer shell + content card


def test_styles_are_inlined_not_only_in_a_style_block():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    # The content <td> carries its font/colour/padding inline — a client that
    # ignores <style> entirely (Outlook desktop) must still render this.
    assert 'style="padding:32px' in html_doc


def test_dark_mode_style_block_is_a_pure_enhancement():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    assert "prefers-color-scheme: dark" in html_doc
    assert 'name="color-scheme" content="light dark"' in html_doc


def test_content_width_is_600px():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    assert 'width="600"' in html_doc
    assert "max-width:600px" in html_doc


def test_logo_has_absolute_url_and_alt_text():
    branding = EmailBranding(logo_url="https://assets.example.com/logo.png", company_name="Acme")
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert 'src="https://assets.example.com/logo.png"' in html_doc
    assert 'alt="Acme"' in html_doc


def test_no_logo_falls_back_to_text_title_not_a_broken_image():
    branding = EmailBranding(logo_url="", company_name="Acme")
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "<img" not in html_doc
    assert "Acme" in html_doc


def test_blank_company_name_and_no_logo_falls_back_to_placeholder():
    branding = EmailBranding(company_name="", logo_url="")
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "<img" not in html_doc
    _assert_well_formed_html(html_doc)


def test_viewport_meta_for_mobile_legibility():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    assert 'name="viewport"' in html_doc


# ── Branding config actually reaches the output ─────────────────────────────


def test_configured_values_appear_in_output():
    branding = EmailBranding(
        company_name="Acme Co",
        logo_url="https://assets.example.com/logo.png",
        primary_color="#003366",
        background_color="#eeeeee",
        footer_text="Acme Co, 1 Main St",
        footer_links=(("Privacy", "https://example.com/privacy"),),
    )
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "https://assets.example.com/logo.png" in html_doc
    assert "#003366" in html_doc
    assert "#eeeeee" in html_doc
    assert "Acme Co, 1 Main St" in html_doc
    assert 'href="https://example.com/privacy"' in html_doc
    assert "Privacy" in html_doc


def test_unset_branding_falls_back_to_generic_defaults_not_a_crash():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="b")
    _assert_well_formed_html(html_doc)
    # The generic template fallback name, not any specific instance's brand.
    assert "Biffo" in html_doc


# ── Escaping: payload-templated content must never be interpreted as markup ─


def test_body_html_is_escaped():
    html_doc = render_email_html(
        EmailBranding(), subject="s", text_body='<script>alert(1)</script> & "quotes"'
    )
    assert "<script>" not in html_doc
    assert "&lt;script&gt;" in html_doc
    assert "&amp;" in html_doc


def test_footer_text_is_escaped():
    branding = EmailBranding(footer_text="<b>bold</b>")
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "<b>bold</b>" not in html_doc
    assert "&lt;b&gt;" in html_doc


def test_footer_link_label_and_url_are_escaped():
    branding = EmailBranding(footer_links=(("<script>", 'https://x.com/"><script>'),))
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "<script>" not in html_doc


def test_company_name_title_fallback_is_escaped():
    branding = EmailBranding(logo_url="", company_name="<b>Acme</b>")
    html_doc = render_email_html(branding, subject="s", text_body="b")
    assert "<b>Acme</b>" not in html_doc


def test_subject_title_tag_is_escaped():
    html_doc = render_email_html(EmailBranding(), subject="<script>x</script>", text_body="b")
    assert "<title><script>" not in html_doc


# ── Paragraph / line-break conversion, and plain-text readability ───────────


def test_blank_line_separated_paragraphs_become_multiple_p_tags():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="Para one.\n\nPara two.")
    assert html_doc.count("<p ") == 2
    assert "Para one." in html_doc
    assert "Para two." in html_doc


def test_single_newline_within_a_paragraph_becomes_br():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="Line one.\nLine two.")
    assert "Line one.<br>Line two." in html_doc


def test_empty_body_renders_a_placeholder_not_nothing():
    html_doc = render_email_html(EmailBranding(), subject="s", text_body="")
    assert "&nbsp;" in html_doc


# ── Subject / sender conventions ─────────────────────────────────────────────


def test_subject_prefix_applied():
    branding = EmailBranding(subject_prefix="[Acme] ")
    assert build_subject(branding, "New lead") == "[Acme] New lead"


def test_subject_prefix_not_duplicated_if_already_present():
    branding = EmailBranding(subject_prefix="[Acme] ")
    assert build_subject(branding, "[Acme] New lead") == "[Acme] New lead"


def test_no_subject_prefix_by_default():
    assert build_subject(EmailBranding(), "New lead") == "New lead"


def test_from_name_prepended_to_bare_address():
    branding = EmailBranding(from_name="Acme Notifications")
    assert build_source(branding, "no-reply@acme.com") == "Acme Notifications <no-reply@acme.com>"


def test_from_name_does_not_override_an_explicit_display_name():
    branding = EmailBranding(from_name="Acme Notifications")
    assert (
        build_source(branding, "Custom Name <no-reply@acme.com>")
        == "Custom Name <no-reply@acme.com>"
    )


def test_no_from_name_configured_leaves_address_unchanged():
    assert build_source(EmailBranding(), "no-reply@acme.com") == "no-reply@acme.com"


# ── EmailBranding.from_env ────────────────────────────────────────────────────


def test_from_env_defaults_when_nothing_set():
    branding = EmailBranding.from_env({})
    assert branding == EmailBranding()


def test_from_env_reads_all_configured_values():
    env = {
        "EMAIL_BRANDING_COMPANY_NAME": "Acme Co",
        "EMAIL_BRANDING_LOGO_URL": "https://assets.example.com/logo.png",
        "EMAIL_BRANDING_LOGO_ALT": "Acme logo",
        "EMAIL_BRANDING_PRIMARY_COLOR": "#003366",
        "EMAIL_BRANDING_BACKGROUND_COLOR": "#eeeeee",
        "EMAIL_BRANDING_FOOTER_TEXT": "Acme Co, 1 Main St",
        "EMAIL_BRANDING_FOOTER_LINKS": (
            "Privacy|https://example.com/privacy,Terms|https://example.com/terms"
        ),
        "EMAIL_BRANDING_FROM_NAME": "Acme Notifications",
        "EMAIL_BRANDING_SUBJECT_PREFIX": "[Acme] ",
    }
    branding = EmailBranding.from_env(env)
    assert branding.company_name == "Acme Co"
    assert branding.logo_url == "https://assets.example.com/logo.png"
    assert branding.logo_alt == "Acme logo"
    assert branding.primary_color == "#003366"
    assert branding.background_color == "#eeeeee"
    assert branding.footer_text == "Acme Co, 1 Main St"
    assert branding.footer_links == (
        ("Privacy", "https://example.com/privacy"),
        ("Terms", "https://example.com/terms"),
    )
    assert branding.from_name == "Acme Notifications"
    assert branding.subject_prefix == "[Acme] "


def test_from_env_footer_links_drops_malformed_entries():
    env = {
        "EMAIL_BRANDING_FOOTER_LINKS": (
            "Privacy|https://example.com/privacy, malformed-no-pipe, |https://x.com, Label|"
        )
    }
    branding = EmailBranding.from_env(env)
    assert branding.footer_links == (("Privacy", "https://example.com/privacy"),)


def test_from_env_blank_company_name_falls_back_to_default():
    branding = EmailBranding.from_env({"EMAIL_BRANDING_COMPANY_NAME": ""})
    assert branding.company_name == EmailBranding().company_name

"""Branded HTML email layout (issue tabsii-platform#378).

A single shared template every ``email`` action and delivery renders
through — not one template per call site. Branding (logo, colour, footer,
sender conventions) is supplied by configuration rather than hardcoded: this
is the *template* repo, shared by every Biffo instance, so nothing
Tabsii-specific (or specific to any other instance) belongs here. An
instance supplies its own values via the environment variables
:meth:`EmailBranding.from_env` reads; unset ones fall back to a generic,
brand-neutral default that still renders a coherent email.

Rendering choices, made for a real inbox rather than a browser:

- **table-based layout.** Outlook desktop renders HTML email with Word's
  engine, which ignores CSS layout (flexbox, grid, floats) entirely —
  ``<table>`` is the one layout primitive every mainstream client agrees on.
- **every layout/type style is inlined** on the element it affects. The one
  ``<style>`` block that exists is a pure enhancement (dark-mode colour
  overrides): a client that ignores ``<style>`` blocks altogether (Outlook
  among them) still renders the light-mode inline styles correctly, just
  without the override — nothing depends on the cascade for the base look.
- **~600px fixed content width**, comfortable on a phone screen without a
  media query.
- **the logo, if configured, is an ``<img>`` with alt text** referenced by an
  absolute URL — SES does not host attachments, so any image must already be
  reachable from wherever the recipient's client fetches it.
- **content is escaped**, never interpreted as markup. The text this module
  renders has already been through the event-payload ``{field}`` templating
  in :mod:`orchestrator.actions` (``_render``) before it reaches here, and
  that payload can carry attacker-influenced strings (a lead's freeform
  name, say) — so every value this module places into the HTML goes through
  :func:`html.escape` first. This module does not introduce a second
  templating mechanism: it renders the *result* of the existing one.
"""

from __future__ import annotations

import html
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

# Generic, brand-neutral fallbacks — deliberately not Tabsii's (or anyone
# else's) actual colours/name. An instance that configures nothing still gets
# a coherent, readable email rather than a broken or blank-looking one.
_DEFAULT_COMPANY_NAME = "Biffo"
_DEFAULT_PRIMARY_COLOR = "#1f2933"
_DEFAULT_BACKGROUND_COLOR = "#f4f5f7"
_DEFAULT_MUTED_COLOR = "#6b7280"
_DEFAULT_BORDER_COLOR = "#e5e7eb"


@dataclass(frozen=True)
class EmailBranding:
    """The configurable surface an instance supplies its own values for.

    Every field has a sensible, generic default, so constructing
    ``EmailBranding()`` with nothing set still renders a complete, legible
    email — the fallback path :func:`orchestrator.actions.send_email` takes
    when the caller passes no branding at all (e.g. in a test, or before an
    instance's Terraform sets these environment variables).
    """

    company_name: str = _DEFAULT_COMPANY_NAME
    logo_url: str = ""
    logo_alt: str = ""
    primary_color: str = _DEFAULT_PRIMARY_COLOR
    background_color: str = _DEFAULT_BACKGROUND_COLOR
    footer_text: str = ""
    # (label, url) pairs, e.g. (("Privacy", "https://example.com/privacy"),).
    footer_links: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    # Sender display name, prepended to the verified `from` address unless
    # that address already carries its own ("Name <addr>").
    from_name: str = ""
    # Prepended to every subject unless the subject already starts with it —
    # e.g. "[Tabsii] " — so subject-line convention is set once, not per
    # workflow. Empty (the default) applies no prefix at all.
    subject_prefix: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> EmailBranding:
        """Read the branding config surface from the process environment.

        Every key is optional; an unset one keeps this dataclass's default.
        This is the one place instance-supplied branding enters the
        orchestrator — ``OrchestratorPlugin`` calls it once at cold start
        (mirroring ``_whatsapp_from_ssm``'s "read once, reuse across warm
        invocations" shape) and threads the result through every ``email``
        dispatch.
        """
        source = os.environ if env is None else env
        defaults = cls()
        return cls(
            company_name=source.get("EMAIL_BRANDING_COMPANY_NAME") or defaults.company_name,
            logo_url=source.get("EMAIL_BRANDING_LOGO_URL", defaults.logo_url),
            logo_alt=source.get("EMAIL_BRANDING_LOGO_ALT", defaults.logo_alt),
            primary_color=source.get("EMAIL_BRANDING_PRIMARY_COLOR") or defaults.primary_color,
            background_color=(
                source.get("EMAIL_BRANDING_BACKGROUND_COLOR") or defaults.background_color
            ),
            footer_text=source.get("EMAIL_BRANDING_FOOTER_TEXT", defaults.footer_text),
            footer_links=_parse_footer_links(source.get("EMAIL_BRANDING_FOOTER_LINKS", "")),
            from_name=source.get("EMAIL_BRANDING_FROM_NAME", defaults.from_name),
            subject_prefix=source.get("EMAIL_BRANDING_SUBJECT_PREFIX", defaults.subject_prefix),
        )


def _parse_footer_links(raw: str) -> tuple[tuple[str, str], ...]:
    """Parse ``"Label|https://url,Label2|https://url2"`` into pairs.

    A comma-separated list of ``Label|URL`` is the same shape the portal's
    other single-line config inputs already use (cf. ``_template_params`` in
    ``actions.py`` for the WhatsApp template parameters). An entry missing
    the ``|`` separator, or with a blank label or URL, is dropped rather than
    raising — a typo in one footer link should not break every email.
    """
    links: list[tuple[str, str]] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or "|" not in entry:
            continue
        label, _, url = entry.partition("|")
        label, url = label.strip(), url.strip()
        if label and url:
            links.append((label, url))
    return tuple(links)


def build_subject(branding: EmailBranding, subject: str) -> str:
    """Apply the configured subject-line prefix, once."""
    prefix = branding.subject_prefix
    if prefix and not subject.startswith(prefix):
        return f"{prefix}{subject}"
    return subject


def build_source(branding: EmailBranding, address: str) -> str:
    """Compose SES's ``Source`` header with a consistent display name.

    Only applied when ``address`` doesn't already carry its own display name
    (no ``<`` in it) and a ``from_name`` is actually configured — an explicit
    ``"Name <addr>"`` written into a workflow's ``from`` always wins, so this
    never overrides an intentional per-workflow override.
    """
    if "<" in address or not branding.from_name:
        return address
    return f"{branding.from_name} <{address}>"


def render_email_html(branding: EmailBranding, *, subject: str, text_body: str) -> str:
    """Render ``text_body`` into the shared branded HTML layout.

    ``subject`` and ``text_body`` are the already-rendered strings (event
    payload ``{field}`` templates already filled in by
    ``orchestrator.actions._render``) — this function only escapes and lays
    them out, it does not template.
    """
    header_html = _logo_block(branding) if branding.logo_url else _title_block(branding)
    body_html = _text_to_html_paragraphs(text_body)
    footer_html = _footer_block(branding)
    escaped_subject = html.escape(subject)
    primary = html.escape(branding.primary_color, quote=True)
    background = html.escape(branding.background_color, quote=True)
    border = html.escape(_DEFAULT_BORDER_COLOR, quote=True)
    muted = html.escape(_DEFAULT_MUTED_COLOR, quote=True)

    return f"""<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{escaped_subject}</title>
<style>
  @media (prefers-color-scheme: dark) {{
    .biffo-email-bg {{ background-color: #1c1c1e !important; }}
    .biffo-email-card {{ background-color: #2c2c2e !important; }}
    .biffo-email-text {{ color: #f2f2f7 !important; }}
    .biffo-email-muted {{ color: #a1a1a6 !important; }}
    .biffo-email-border {{ border-color: #3a3a3c !important; }}
  }}
</style>
</head>
<body class="biffo-email-bg" style="margin:0; padding:0; background-color:{background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
style="background-color:{background};">
<tr>
<td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
class="biffo-email-card"
style="width:600px; max-width:600px; background-color:#ffffff; border-radius:8px;
overflow:hidden;">
<tr>
<td class="biffo-email-border" style="padding:24px 32px; border-bottom:1px solid {border};">
{header_html}
</td>
</tr>
<tr>
<td class="biffo-email-text" style="padding:32px; font-family:{_FONT_STACK}; font-size:16px;
line-height:1.6; color:{primary};">
{body_html}
</td>
</tr>
<tr>
<td class="biffo-email-muted biffo-email-border" style="padding:24px 32px;
border-top:1px solid {border}; font-family:{_FONT_STACK}; font-size:12px;
line-height:1.5; color:{muted};">
{footer_html}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>"""


def _logo_block(branding: EmailBranding) -> str:
    alt = html.escape(branding.logo_alt or branding.company_name or "logo")
    src = html.escape(branding.logo_url, quote=True)
    return (
        f'<img src="{src}" alt="{alt}" width="140" '
        'style="display:block; border:0; outline:none; text-decoration:none; '
        'max-width:140px; height:auto;">'
    )


def _title_block(branding: EmailBranding) -> str:
    """Text fallback header when no logo is configured — still branded."""
    name = html.escape(branding.company_name or "")
    if not name:
        return "&nbsp;"
    primary = html.escape(branding.primary_color, quote=True)
    return (
        f'<span style="font-family:{_FONT_STACK}; font-size:20px; '
        f'font-weight:600; color:{primary};">{name}</span>'
    )


def _footer_block(branding: EmailBranding) -> str:
    parts: list[str] = []
    if branding.footer_text:
        parts.append(html.escape(branding.footer_text))
    if branding.footer_links:
        muted = html.escape(_DEFAULT_MUTED_COLOR, quote=True)
        links_html = " &nbsp;|&nbsp; ".join(
            f'<a href="{html.escape(url, quote=True)}" style="color:{muted}; '
            f'text-decoration:underline;">{html.escape(label)}</a>'
            for label, url in branding.footer_links
        )
        parts.append(links_html)
    if not parts:
        return "&nbsp;"
    return "<br>".join(parts)


_BLANK_LINE = re.compile(r"\n\s*\n")


def _text_to_html_paragraphs(text: str) -> str:
    """Turn a plain-text body into escaped, paragraph-per-blank-line HTML.

    The same string that becomes the plain-text MIME part
    (``orchestrator.actions.send_email`` renders both from the identical
    ``body`` template) — this is the one transformation applied for the HTML
    part: escape it, then split blank-line-separated blocks into ``<p>`` and
    single newlines within a block into ``<br>``, so a workflow author
    writing ordinary paragraphs gets a readable HTML email with zero extra
    authoring effort or a second templating syntax to learn.
    """
    stripped = text.strip("\n")
    if not stripped.strip():
        return '<p style="margin:0;">&nbsp;</p>'
    blocks = _BLANK_LINE.split(stripped)
    paragraphs = []
    for block in blocks:
        block = block.strip("\n")
        if not block.strip():
            continue
        escaped = html.escape(block).replace("\n", "<br>")
        paragraphs.append(f'<p style="margin:0 0 16px 0;">{escaped}</p>')
    if not paragraphs:
        return '<p style="margin:0;">&nbsp;</p>'
    return "\n".join(paragraphs)

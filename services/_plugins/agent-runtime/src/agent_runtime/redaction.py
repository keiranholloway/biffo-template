"""Redaction applied on the way out of the platform (ADR-0014, Security model).

The ADR is explicit that this is the **runtime's** responsibility, not the worker
author's: "Redaction is the runtime's responsibility, not the worker author's, so
it cannot be forgotten in a prompt." So it lives here, on the only path that
builds a payload for the model (``messages.build_messages``), rather than in
prompt text a definition could omit or an author could edit away.

Email addresses are the one class redacted today. They are the highest-value
identifier in a prospect record and no enrichment task needs them — brand, size
and role are all derivable without one. Name, company and role survive redaction
and remain personal data, so the provider relationship still carries a processing
obligation; this reduces exposure, it does not eliminate it.

The redaction is structural (walk the value, rewrite every string) rather than
key-based, because the payload comes from a public form: an attacker choosing to
put an address in ``company`` rather than ``email`` must not defeat it.
"""

from __future__ import annotations

import re
from typing import Any

#: Deliberately broad rather than RFC-5322 exact. Over-matching costs a little
#: fidelity in a prompt; under-matching leaks an identifier off-platform, so the
#: asymmetry decides the trade.
EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

#: What a redacted address is replaced with. A visible marker, not deletion: the
#: model should be able to tell an address was present and withheld, so it does
#: not hallucinate one or report the field as missing.
EMAIL_PLACEHOLDER = "[redacted:email]"


def redact_emails(value: Any) -> Any:
    """Return *value* with every email address in every string replaced.

    Recurses through dicts, lists and tuples; dict keys are walked too, since a
    form field name is as attacker-controlled as its value. Non-string scalars
    are returned unchanged.
    """
    if isinstance(value, str):
        return EMAIL_PATTERN.sub(EMAIL_PLACEHOLDER, value)
    if isinstance(value, dict):
        return {redact_emails(key): redact_emails(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_emails(item) for item in value]
    return value

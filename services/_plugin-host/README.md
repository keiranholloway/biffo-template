# biffo-plugin-host

The shared plugin-host runtime for [Biffo](https://github.com/keiranholloway/biffo-template)
(ADR-0021): one Lambda mounts every installed user-facing plugin's API behind
the Core API Gateway at `/api/v1/plugins/*`.

A user-facing plugin is pure code — an ASGI app referenced as `"<module>:<attr>"`
in its manifest's `user_ingress.app` (and optionally `admin_ingress.app`) — not
its own Lambda function or its own Mangum handler. This package is the host that
discovers those manifests, imports each plugin's app, and mounts it behind the
platform's authentication and per-plugin identity assertion.

## Install

```bash
pip install biffo-plugin-host
```

## Use

```python
from plugin_host.discover import discover_plugins, load_app

plugins = discover_plugins("services")
app = load_app("marketing.app:app")
```

This is the same discovery and mount logic the platform runs in production
(`services/_plugin-host/` in the template). It is published so a plugin repo's
own conformance checks can import and exercise the real host, rather than
re-implementing a mock of it.

## Versioning

`biffo-plugin-host` carries its own independent semver, separate from the
template's core version — see the header comment in `pyproject.toml` for the
full rationale (the same one `packages/python-sdk/pyproject.toml` records for
`biffo-plugin-sdk`).

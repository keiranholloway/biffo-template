# biffo-plugin-sdk

The Python SDK for building [Biffo](https://github.com/keiranholloway/biffo-template)
plugins: manifest validation, a Core API client, and the event subscription
system.

A Biffo plugin is a Lambda-deployed Python package that extends a Biffo
instance. It declares its tables, routes and event subscriptions in a
`biffo.plugin.json` manifest, and reaches platform data only through the Core
API — never through a database client of its own (ADR-0002). This SDK is the
supported way to do both.

## Install

```bash
pip install biffo-plugin-sdk
```

Outside AWS Lambda, install the `sigv4` extra as well:

```bash
pip install "biffo-plugin-sdk[sigv4]"
```

`botocore` — needed to sign requests to the Core API — is an extra rather than a
hard dependency because it is preinstalled in the AWS Lambda Python runtime, so
a deployed plugin already has it. The SDK imports it lazily, so
`import biffo_plugin_sdk` works without it.

## Versioning

This package carries its **own** semantic version, independent of the Biffo
template's `core.version`. It is a public API contract for plugin authors: a
major bump here means the plugin API broke, and nothing else. Plugin manifests
declare `"biffo-plugin-sdk": "^1.0"` and plugin `pyproject.toml` files pin
`biffo-plugin-sdk>=1.0,<2.0`.

## Quick start

```python
from biffo_plugin_sdk import BiffoEvent, BiffoPluginBase, load_manifest


class MyPlugin(BiffoPluginBase):
    def __init__(self) -> None:
        super().__init__(load_manifest("biffo.plugin.json"))

        @self.subscribe("user.created")
        async def on_user_created(event: BiffoEvent) -> None:
            await self.api.post(
                "/api/v1/internal/welcome", json={"user": event.detail}
            )

    def on_install(self) -> None: ...

    def on_uninstall(self) -> None: ...
```

Handlers are registered against `self.events`, an `EventSubscriber` private to
the instance. In the Lambda entrypoint, turn the raw EventBridge payload into a
`BiffoEvent` and dispatch it:

```python
from biffo_plugin_sdk import create_event_handler

plugin = MyPlugin()


async def handler(raw_event: dict, context: object) -> None:
    await plugin.events.dispatch(create_event_handler(raw_event))
```

`self.api` is built by `create_core_client()` and defaults to a
`SignedCoreClient` — every request is signed with AWS SigV4 using the plugin
Lambda's role, which is the plugin→Core auth mechanism (ADR-0009). Set
`BIFFO_CORE_AUTH_MODE=none` for an unsigned client in local runs and tests.

## Public API

| Export                                                                                                     | What it is                                                                              |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `BiffoPluginBase`                                                                                          | Base class for a plugin; owns `self.api` and the `subscribe`/`subscribe_all` decorators |
| `PluginManifest`, `load_manifest`, `register_plugin`                                                       | Manifest model and loaders — the authoritative validator for `biffo.plugin.json`        |
| `TableDefinition`, `ColumnDefinition`, `IndexDefinition`, `TablePermissions`, `PermissionRule`, `RouteDef` | Manifest sub-models                                                                     |
| `BiffoAPIClient`, `BiffoAPIError`                                                                          | Unauthenticated async Core API transport, and its single error type                     |
| `SignedCoreClient`, `create_core_client`                                                                   | SigV4-signing client (ADR-0009) and the factory that picks it by default                |
| `BiffoEvent`, `EventSubscriber`, `create_event_handler`                                                    | Event model, dispatch registry, and the raw-EventBridge-payload parser                  |

## Environment

| Variable               | Read by              | Purpose                                                                           |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `BIFFO_CORE_API_URL`   | `BiffoAPIClient`     | Core API base URL; injected into the plugin Lambda by `modules/plugins/_template` |
| `AWS_REGION`           | `SignedCoreClient`   | Region to sign for                                                                |
| `BIFFO_CORE_AUTH_MODE` | `create_core_client` | `sigv4` (default) or `none`                                                       |

## Documentation

- [ADR-0003 — Plugin system and marketplace](https://github.com/keiranholloway/biffo-template/blob/main/docs/ADR/0003-plugin-system-and-marketplace.md)
- [ADR-0009 — Internal service authentication](https://github.com/keiranholloway/biffo-template/blob/main/docs/ADR/0009-internal-service-authentication.md)
- [Plugin authoring guide](https://github.com/keiranholloway/biffo-template/blob/main/docs/guides/plugins.md)

## License

MIT — see [LICENSE](LICENSE).

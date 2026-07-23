"""The agent-runtime function name is derived by convention (ADR-0016).

Core no longer receives BIFFO_AGENT_RUNTIME_FUNCTION_NAME from Terraform. Instead
``Settings`` derives it from the Lambda's own ``AWS_LAMBDA_FUNCTION_NAME`` by
swapping the trailing ``core-api`` for ``plugin-agent-runtime`` — the compute
module's ``<project>-<env>-<function>`` naming convention. This is what makes the
Core->runtime sync-invoke wiring distributable template-owned: an upgraded or
freshly-init'd instance gets a live assistant, not a 503, with no per-instance
env var to hand-wire.
"""

from api.config import Settings


def test_derives_runtime_name_from_core_api_function_name(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "tabsii-platform-dev-core-api")
    monkeypatch.delenv("BIFFO_AGENT_RUNTIME_FUNCTION_NAME", raising=False)

    assert Settings().agent_runtime_function_name == "tabsii-platform-dev-plugin-agent-runtime"


def test_explicit_value_wins_over_derivation(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "tabsii-platform-dev-core-api")
    monkeypatch.setenv("BIFFO_AGENT_RUNTIME_FUNCTION_NAME", "explicitly-set-runtime")

    assert Settings().agent_runtime_function_name == "explicitly-set-runtime"


def test_empty_when_function_name_does_not_end_in_core_api(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "tabsii-platform-dev-pr-signer")
    monkeypatch.delenv("BIFFO_AGENT_RUNTIME_FUNCTION_NAME", raising=False)

    assert Settings().agent_runtime_function_name == ""


def test_empty_when_lambda_function_name_absent(monkeypatch):
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME", raising=False)
    monkeypatch.delenv("BIFFO_AGENT_RUNTIME_FUNCTION_NAME", raising=False)

    assert Settings().agent_runtime_function_name == ""

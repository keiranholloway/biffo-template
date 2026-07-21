"""Tests for resolving the WhatsApp credentials from SSM at cold start.

The Lambda carries only the parameter *names*; the token itself is fetched at
construction so it never appears in the function's configuration — nor in
Terraform state, which is what a `whatsapp_access_token` variable would have
meant.
"""

from __future__ import annotations

import pytest
from biffo_plugin_sdk import BiffoEvent
from orchestrator.plugin import OrchestratorPlugin, _whatsapp_from_ssm
from orchestrator_fakes import FakeCore, FakeHttp, FakeSes, FakeSsm

_TOKEN_PARAM = "/myproject/dev/whatsapp/access-token"
_NUMBER_PARAM = "/myproject/dev/whatsapp/phone-number-id"


@pytest.fixture
def configured(monkeypatch) -> FakeSsm:
    monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN_PARAMETER", _TOKEN_PARAM)
    monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", _NUMBER_PARAM)
    return FakeSsm({_TOKEN_PARAM: "tok-secret", _NUMBER_PARAM: "1234567890"})


def test_reads_both_parameters_with_decryption(configured: FakeSsm):
    settings = _whatsapp_from_ssm(configured)

    assert settings.configured
    assert settings.access_token == "tok-secret"
    assert settings.phone_number_id == "1234567890"
    # The token is a SecureString — it must be fetched decrypted.
    assert all(call["WithDecryption"] for call in configured.calls)
    assert [call["Name"] for call in configured.calls] == [_TOKEN_PARAM, _NUMBER_PARAM]


def test_unconfigured_when_no_parameter_names_are_set(monkeypatch):
    monkeypatch.delenv("WHATSAPP_ACCESS_TOKEN_PARAMETER", raising=False)
    monkeypatch.delenv("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", raising=False)
    ssm = FakeSsm()

    settings = _whatsapp_from_ssm(ssm)

    assert not settings.configured
    # No name, no fetch — an unconfigured action costs nothing at cold start.
    assert ssm.calls == []


def test_unconfigured_when_only_one_name_is_set(monkeypatch):
    monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN_PARAMETER", _TOKEN_PARAM)
    monkeypatch.delenv("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", raising=False)
    ssm = FakeSsm({_TOKEN_PARAM: "tok-secret"})

    settings = _whatsapp_from_ssm(ssm)

    assert not settings.configured
    assert ssm.calls == []


def test_a_failed_fetch_degrades_instead_of_raising(monkeypatch):
    # A missing parameter or a denied permission must not stop the engine from
    # starting — email and Chat workflows have nothing to do with WhatsApp.
    monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN_PARAMETER", _TOKEN_PARAM)
    monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", _NUMBER_PARAM)
    ssm = FakeSsm({})  # neither parameter exists

    settings = _whatsapp_from_ssm(ssm)

    assert not settings.configured


def test_api_version_comes_from_the_environment(configured: FakeSsm, monkeypatch):
    monkeypatch.setenv("WHATSAPP_API_VERSION", "v23.0")
    assert _whatsapp_from_ssm(configured).api_version == "v23.0"


async def test_a_failed_fetch_does_not_stop_other_actions(monkeypatch):
    """The whole point of degrading rather than raising: a broken WhatsApp setup
    must not take email and Chat workflows down with it."""
    monkeypatch.setenv("WHATSAPP_ACCESS_TOKEN_PARAMETER", _TOKEN_PARAM)
    monkeypatch.setenv("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", _NUMBER_PARAM)
    run = {
        "run_id": "run-1",
        "definition_id": "def-1",
        "action_type": "email",
        "action_config": {"from": "no-reply@example.com", "to": "sales@example.com"},
        "created": True,
    }
    core = FakeCore([run])
    ses = FakeSes()

    plugin = OrchestratorPlugin(
        api=core.client(),
        ses_client=ses,
        http_client=FakeHttp(),
        ssm_client=FakeSsm({}),  # every fetch raises
    )
    await plugin.process_event(
        BiffoEvent(
            source="biffo.core",
            detail_type="demo.requested",
            payload={"demo_request_id": "d1"},
        )
    )

    assert not _whatsapp_from_ssm(FakeSsm({})).configured
    assert len(ses.calls) == 1
    assert core.result_posts()[0]["status"] == "succeeded"

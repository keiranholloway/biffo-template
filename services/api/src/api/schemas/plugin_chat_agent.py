"""Request/response schemas for the plugin-chat-agent admin API (ADR-0017 seam #1 extension).

Cognito-authenticated, admin-gated, tenant-scoped. The plugin_name and agent_key
follow the same slug patterns as plugin manifests and PluginChatAgentDef.key in
routing/chat_agent_registration.py — both use ``^[a-z][a-z0-9-]*$``.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .base import BiffoBaseSchema


class CreatePluginChatAgentRequest(BaseModel):
    """Create a new live, admin-editable chat agent."""

    agent_key: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    agent_name: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=50)
    system_prompt: str = Field(min_length=1)
    model: str = Field(min_length=1)
    required_group: str = Field(min_length=1)
    active: bool = Field(default=True)
    max_history_messages: int = Field(default=40, gt=0)
    max_output_tokens: int = Field(default=1024, gt=0)
    timeout_seconds: float = Field(default=20.0, gt=0)


class UpdatePluginChatAgentRequest(BaseModel):
    """Update an existing live chat agent (full replace of mutable fields)."""

    agent_name: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=50)
    system_prompt: str = Field(min_length=1)
    model: str = Field(min_length=1)
    required_group: str = Field(min_length=1)
    active: bool = Field(default=True)
    max_history_messages: int = Field(default=40, gt=0)
    max_output_tokens: int = Field(default=1024, gt=0)
    timeout_seconds: float = Field(default=20.0, gt=0)


class PluginChatAgentResponse(BiffoBaseSchema):
    """A live-editable chat agent row (read response)."""

    plugin_name: str
    agent_key: str
    agent_name: str
    role: str
    system_prompt: str
    model: str
    required_group: str
    active: bool
    max_history_messages: int
    max_output_tokens: int
    timeout_seconds: float


class PluginChatAgentHistoryResponse(BiffoBaseSchema):
    """One edit in a chat agent's history (read response).

    Stores the previous values of the row before an edit, keyed by agent and
    version number. The version is a monotonic counter per agent, starting at 1.
    """

    plugin_chat_agent_id: str
    plugin_name: str
    agent_key: str
    version: int
    agent_name: str
    role: str
    system_prompt: str
    model: str
    required_group: str
    active: bool
    max_history_messages: int
    max_output_tokens: int
    timeout_seconds: float
    changed_by: str
    created_at: datetime


class SeedPluginChatAgentRequest(BaseModel):
    """A single role definition for seeding.

    Reuses the fields from CreatePluginChatAgentRequest.
    """

    agent_key: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    agent_name: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=50)
    system_prompt: str = Field(min_length=1)
    model: str = Field(min_length=1)
    required_group: str = Field(min_length=1)
    active: bool = Field(default=True)
    max_history_messages: int = Field(default=40, gt=0)
    max_output_tokens: int = Field(default=1024, gt=0)
    timeout_seconds: float = Field(default=20.0, gt=0)


class SeedPluginChatAgentResponse(BaseModel):
    """Result of seeding one role — indicates whether it was created or already existed."""

    role: str
    created: bool

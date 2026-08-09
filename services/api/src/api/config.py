import os

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BIFFO_", case_sensitive=False)

    # Database — two modes:
    #   Local dev: set database_url directly (localhost default works out of the box).
    #   AWS staging/prod: set db_secret_arn + db_host; credentials fetched from Secrets Manager.
    #   AWS dev (no-NAT): set database_url to the full URL output by Terraform (no outbound call).
    database_url: str = "postgresql+asyncpg://localhost/biffo_dev"
    db_secret_arn: str = ""
    db_host: str = ""

    # Least-privilege application role (#253). The settings above resolve the
    # RDS *master* user — table owner, rds_superuser — which migrations,
    # biffo:db-init and biffo:ddl-import need because they create and alter
    # objects. These resolve the non-owner `biffo_app` role that the HTTP
    # request path connects as instead. Same two modes as above:
    #   AWS staging/prod: app_db_secret_arn (a second Secrets Manager secret).
    #   AWS dev (no-NAT) / local: app_database_url, the full URL.
    # Both unset means no privilege split on this deployment and the request
    # path falls back to the master URL — see database.resolve_app_database_url
    # for why that fallback exists and how it is surfaced.
    app_database_url: str = ""
    app_db_secret_arn: str = ""

    # Postgres search_path applied at connection startup, e.g. "public,acme".
    # Empty by default so the base template is unaffected. Needed only when a
    # deployment maps ADR-0005 DDL-imported tables by bare name in a non-public
    # schema — those are unreachable without it (#458, backported from tabsii).
    db_search_path: str = ""
    # Must match the `username` in the app credential; db-init cross-checks.
    app_role_name: str = "biffo_app"
    # Comma-separated schemas to grant the app role. Empty (the default) grants
    # every non-system schema found at bootstrap time, which is what an
    # ADR-0005 deployment with its own business schema needs. See
    # api.db_app_role's module docstring.
    app_role_schemas: str = ""

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    cognito_region: str = "us-east-1"
    # Pre-loaded JWKS JSON string — set by Terraform at apply time in no-NAT dev environments
    # so the Lambda can verify JWTs without needing to reach the Cognito JWKS endpoint.
    # If empty, the JWKS is fetched at runtime (requires NAT or cognito-idp VPC endpoint).
    cognito_jwks_json: str = ""

    # EventBridge
    event_bus_name: str = "biffo-events"

    # Plugins (ADR-0003) — directory containing one subdirectory per service,
    # scanned for */biffo.plugin.json. Empty string uses the monorepo's
    # services/ directory (see api.plugins._DEFAULT_SERVICES_ROOT); only
    # meaningful in contexts with a full monorepo checkout — see the
    # api.plugins module docstring for the deployed-Lambda limitation.
    plugin_services_root: str = ""

    # DDL data imports (ADR-0005) — directory containing one subdirectory per
    # import, scanned for */*.sql. Empty string uses the monorepo's
    # db/imports/ directory (see api.ddl_import._DEFAULT_DDL_IMPORT_ROOT);
    # set by Terraform to /var/task/db/imports in the deployed Lambda.
    ddl_import_root: str = ""

    # Endpoint control plane (ADR-0008) — the isolated PR-signer Lambda the Core
    # API invokes to open a permission-change PR. Empty means the control plane
    # isn't provisioned on this deployment (the admin permission endpoint then
    # returns 501). Set by Terraform from the pr_signer module's function name.
    pr_signer_function_name: str = ""

    # Cognito group that authorises admin-only endpoints (ADR-0008 permission
    # changes, and future user management). Membership comes from the verified
    # cognito:groups claim; matches the baseline "admin" group Terraform seeds.
    admin_group: str = "admin"

    # Cognito group conferring platform-admin (ADR-0012). The group on the
    # verified token is the source of truth; `AuthenticatedUser.is_platform_admin`
    # mirrors it. Deployments whose RLS policies read a table rather than the
    # token reconcile that table in their provider's sync_platform_admin. No
    # subject is ever hard-coded — add the platform owners to this group in
    # Cognito and they gain it on their next request, with no code or config
    # change.
    platform_admin_group: str = "platform_admin"

    # Internal service-to-service auth (ADR-0009) — allowlist of IAM principal
    # ARNs permitted on /api/v1/internal/* routes. The SigV4-verified caller's
    # requestContext.authorizer.iam.userArn is matched (fnmatch glob) against
    # this list. Fails closed: empty means no service caller is accepted. Set by
    # Terraform (JSON array) from each authorised plugin's Lambda role ARN, e.g.
    # ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-orchestrator-*/*"].
    service_principal_arn_allowlist: list[str] = []

    # Agentic workers (ADR-0014 §8) — the maximum chain depth an agent run may
    # be requested at. Agent runs emit events and events start agent runs, so
    # the cycle is real and every iteration has an LLM invoice attached; the
    # internal create route refuses a request past this depth rather than
    # clamping it. A direct (event → agent) run is depth 0, so the default
    # permits two further generations of agent-triggered-by-agent.
    agent_max_run_depth: int = 2

    # Write-back (ADR-0027) — consecutive denials before a definition disables
    # itself (biffo-template#680). A workflow whose owner has left should stop
    # trying, visibly, rather than generating a denial per event forever.
    #
    # Configurable because the right number depends on traffic, not on Core: three
    # denials is minutes on a busy trigger and weeks on a quiet one, so an operator
    # tuning this is expressing "how long before I want to be told", which Core
    # cannot know. The default is unchanged from the constant it replaces.
    writeback_max_consecutive_denials: int = 3

    # Agentic workers — default model for agent runs (ADR-0017, biffo-template#910).
    # When an orchestration workflow's agent action provides no model, and the
    # agent is not found in the registry (or the registry row has no model), this
    # is the fallback. A single source of truth for the default model, ensuring
    # that no duplicate defaults drift apart as the codebase changes.
    agent_default_model: str = "moonshotai/kimi-k3"

    # Prompt assistant (ADR-0016, buffered amendment) — the synchronous chat spine.
    #
    # Core fronts the turn through its existing API Gateway + Cognito auth, then
    # synchronously invokes the agent-runtime Lambda (RequestResponse) for the LLM
    # turn. This is the runtime's function NAME to invoke; empty means the assistant
    # is not wired on this deployment (the endpoint then returns 503).
    #
    # Not set by Terraform. It is derived by CONVENTION at startup from the Lambda's
    # own AWS_LAMBDA_FUNCTION_NAME (see the model validator below), the same
    # derive-by-convention philosophy the template uses for the runtime ARN. This
    # is what lets the Core->runtime sync-invoke wiring be distributed
    # template-owned (ADR-0016): no per-instance BIFFO_AGENT_RUNTIME_FUNCTION_NAME
    # env var to hand-wire, so an upgraded or freshly-init'd instance gets a live
    # assistant instead of a 503. An explicit value still wins as an override.
    agent_runtime_function_name: str = ""
    # The assistant's model — a platform config value, not per-user (ADR-0016 §4).
    # Any OpenRouter model slug; the runtime resolves the one OpenRouter key.
    agent_assistant_model: str = "anthropic/claude-sonnet-4"
    # Hard turn bounds sized for the API Gateway ~29s integration cap the amendment
    # accepts (ADR-0016 §8). The runtime clamps to its own ceilings too; these are
    # what Core asks for.
    agent_assistant_max_output_tokens: int = 1024
    agent_assistant_timeout_seconds: float = 20.0
    # How much prior conversation to replay as history (ADR-0016 §2, §8 thread
    # length bound). Counts prior turns (user+assistant messages), newest kept.
    agent_assistant_max_history_messages: int = 40
    # The cap on how many library items (each of prompt components and agent
    # definitions) Core summarises into the turn's library-aware context (ADR-0016
    # §5 Phase 2). A bounded *summary* — name/description/variable-names per
    # component, name/agent/model per definition — not the full bodies, so the
    # context (and the ~29s API Gateway turn budget) stays bounded as the library
    # grows. Overflow is disclosed to the model, not silently dropped.
    agent_assistant_max_library_items: int = 50

    # How long a run may sit in `running` before the reaper fails it (ADR-0014
    # §5, issue #402). A run only reaches `running` by being claimed, so one
    # that stays there past any possible invocation is a runtime that died
    # holding it: already paid for, no result recorded, and nothing waiting on
    # `agent.run.completed` will ever be released.
    #
    # The floor is AWS's own 900s Lambda cap, NOT the agent-runtime module's
    # configured `timeout` (300s). Deriving it from the platform ceiling rather
    # than from a second configurable number means raising the plugin's timeout
    # can never silently bring this below it and start reaping runs that are
    # still legitimately executing — which would be worse than the gap, since
    # the reap would then race a real completion. 1800s leaves an hour's slack
    # over the worst case while still bounding "stuck for ever" to half an hour.
    agent_run_stale_after_seconds: int = 1800

    # How long a run may sit in `pending` — requested but never claimed — before
    # the reaper fails it (idea-scout#27).
    #
    # This is a *separate* number from the one above, deliberately, even though
    # both currently read 1800. They are bounded by different things: the
    # `running` threshold is derived from AWS's 900s invocation cap, whereas an
    # unclaimed run is waiting on event delivery, which no Lambda limit
    # constrains. Collapsing them into one setting would couple two unrelated
    # ceilings, so that raising one to accommodate a slow runtime would silently
    # move the other.
    #
    # The gap this closes: the sweep only ever looked at `running`, and a run
    # that is never claimed never leaves `pending`. So the runs most completely
    # abandoned — nothing ever picked them up — were the only ones invisible to
    # the mechanism built to catch abandoned work. One observed run survived
    # ~17 sweeps over 255 minutes, still presenting to the founder as "Running".
    agent_run_unclaimed_after_seconds: int = 1800

    # How long an orchestration run may sit `pending` or `dispatching` — claimed
    # but never resulted — before the reaper fails it (tabsii-platform#808,
    # mirroring agent_run_stale_after_seconds above and ADR-0014 section 5's
    # precedent for the same failure shape in a different table). Same 900s
    # Lambda-cap floor and the same 1800s slack; see `orchestration.reap_stale_runs`.
    orchestration_run_stale_after_seconds: int = 1800

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]

    # SQLAlchemy engine statement logging. OFF by default, in every environment,
    # and never to be set in a shared one.
    #
    # This was `echo=settings.environment == "dev"`, i.e. on for the whole of
    # every dev deployment — which made CloudWatch a clear-text copy of the
    # database's most sensitive columns. Echo does not log statements; it logs
    # statements *with their bound parameters*, so every INSERT carried the
    # values: complete agent transcripts as `agent_runs.messages` was written,
    # result payloads, the founder-profile snapshot inside each run's
    # `input_payload`, and `owner_sub` beside the rows it owns. Measured on a
    # live dev account: 135 parameter-payload lines in one 48-hour sample, and
    # the same exposure in a second instance's account.
    #
    # That is a different access boundary from the one the data is stored
    # behind. `logs:FilterLogEvents` is granted far more widely than RDS access,
    # and nothing about a Lambda log group's name signals it holds user content
    # — so it also quietly undid a seam Core fails closed on: `/api/v1/internal/*`
    # correctly refuses a non-allowlisted principal, and the same rows were then
    # readable from the log group by anyone who could read logs at all.
    #
    # Paired with `hide_parameters=True` on every engine, because "off by
    # default" alone relies on nobody ever flipping it on a shared deployment to
    # debug something.
    sql_echo: bool = False

    @model_validator(mode="after")
    def _derive_agent_runtime_function_name(self) -> "Settings":
        """Derive the agent-runtime function name by convention (ADR-0016).

        An explicitly-set value always wins. Otherwise derive it from this
        Lambda's own name: the compute module names every function
        ``<project>-<env>-<function>``, so the Core API is
        ``<project>-<env>-core-api`` and the agent-runtime plugin is
        ``<project>-<env>-plugin-agent-runtime``. Swapping the trailing
        ``core-api`` for ``plugin-agent-runtime`` on ``AWS_LAMBDA_FUNCTION_NAME``
        yields the runtime to invoke, with no per-instance Terraform env var.

        Only fires when the name actually ends in ``core-api``; if it doesn't (a
        differently-named function) or ``AWS_LAMBDA_FUNCTION_NAME`` is absent
        (local/tests), the value stays empty and the endpoint returns 503 —
        unchanged behaviour.
        """
        if self.agent_runtime_function_name:
            return self
        own_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
        suffix = "core-api"
        if own_name.endswith(suffix):
            self.agent_runtime_function_name = own_name[: -len(suffix)] + "plugin-agent-runtime"
        return self


settings = Settings()

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { ApiError, createApiClient } from '@/lib/api-client'
import {
  createWorkflow,
  deleteWorkflow,
  fetchCatalog,
  fetchRuns,
  fetchWorkflows,
  setWorkflowEnabled,
  updateWorkflow,
  type ActionConfigValue,
  type CatalogAction,
  type CatalogActionField,
  type DeliveryConfigValue,
  type WriteBackConfigValue,
  type WriteBackTarget,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type CatalogTrigger,
  type CatalogTriggerField,
  type WorkflowInput,
  type WorkflowRun,
} from '@/lib/orchestration-api'
import { startWorkflowDryRun, type WorkflowDryRunRequest } from '@/lib/workflow-dryrun-api'
import { fetchAgentRun, type AgentRunResponse } from '@/lib/agent-runs-api'
import {
  filterTriggers,
  groupTriggersBySource,
  optionLabel,
  originOf,
  triggerKeyOf,
} from '@/lib/trigger-catalog'
import { fetchPromptComponents, type PromptComponent } from '@/lib/prompt-components-api'
import { isInlinePart, normalizeParts, type PromptPart } from '@/lib/prompt-parts'
import { AssistantDrawer } from '@/components/assistant-drawer'
import { PartsField } from './parts-field'
import { OUTCOME_PRESETS } from './presets'
import { buildSampleEvent, formatSampleEvent, parseSampleEvent } from './sample-event'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

/** Pull the FastAPI `{detail}` out of an error body when there is one, else fall
 *  back to the raw text — Core returns `{"detail": "…"}` for 502/503/422. */
function detailOf(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.message) as { detail?: unknown }
      if (typeof parsed.detail === 'string' && parsed.detail !== '') return parsed.detail
    } catch {
      // Body was not JSON — use it as-is.
    }
    return err.message === '' ? `Request failed (${String(err.status)})` : err.message
  }
  return errorMessage(err)
}

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

/** One row of the "only when" editor. Kept as a list, not an object, so a row
 *  being typed into can have an empty field name without collapsing. */
interface FilterRow {
  field: string
  value: string
}

/** Rows -> the API's trigger_filter. Rows with no field name are dropped; no
 *  usable rows at all means null (matches every event). */
function toTriggerFilter(rows: FilterRow[]): Record<string, string> | null {
  const entries = rows
    .map((r) => [r.field.trim(), r.value] as const)
    .filter(([field]) => field !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function toFilterRows(filter: Record<string, string> | null | undefined): FilterRow[] {
  return Object.entries(filter ?? {}).map(([field, value]) => ({ field, value }))
}

// The field-select sentinel that reveals the free-text "custom field" input —
// the escape hatch so a trigger's undeclared field (and observed events with no
// declared fields at all) can still be filtered on.
const CUSTOM_FIELD = '__custom__'

// A condition's chosen field definition, if it names one the trigger declares.
function findTriggerField(
  fields: CatalogTriggerField[],
  name: string,
): CatalogTriggerField | undefined {
  return fields.find((f) => f.name === name)
}

// An enumerable field offers a value dropdown; anything else stays free text.
function isEnumerable(field: CatalogTriggerField | undefined): boolean {
  return field?.type === 'enum' && field.values.length > 0
}

// Run status -> badge colour. Terminal failure reads red, success green, and
// anything still in flight stays neutral.
const runStatusClass: Record<string, string> = {
  succeeded: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  skipped: 'bg-amber-100 text-amber-700',
  scheduled: 'bg-sky-100 text-sky-700',
  dispatching: 'bg-sky-100 text-sky-700',
}

// Timing (docs/implementation/0002-scheduled-workflow-actions): the units the
// "run after a delay" control offers, and their conversion to delay_seconds —
// the only shape schedule_config's fixed_delay carries.
type ScheduleUnit = 'minutes' | 'hours' | 'days' | 'weeks'

const SCHEDULE_UNIT_SECONDS: Record<ScheduleUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
  weeks: 7 * 24 * 60 * 60,
}

const SCHEDULE_UNIT_ORDER: ScheduleUnit[] = ['weeks', 'days', 'hours', 'minutes']

/** Value + unit -> delay_seconds, or null when the value isn't a positive integer. */
function scheduleDelaySeconds(value: string, unit: ScheduleUnit): number | null {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) return null
  return n * SCHEDULE_UNIT_SECONDS[unit]
}

/** delay_seconds -> the largest whole unit it divides evenly into, so editing
 * a stored delay shows e.g. "2 weeks" rather than "20160 minutes". Falls back
 * to minutes (rounded) when nothing divides evenly. */
function secondsToScheduleValue(seconds: number): { value: string; unit: ScheduleUnit } {
  for (const unit of SCHEDULE_UNIT_ORDER) {
    const perUnit = SCHEDULE_UNIT_SECONDS[unit]
    if (seconds % perUnit === 0) {
      return { value: String(seconds / perUnit), unit }
    }
  }
  return { value: String(Math.round(seconds / SCHEDULE_UNIT_SECONDS.minutes)), unit: 'minutes' }
}

function formatWhen(iso: string | null): string {
  if (iso == null) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** The error from a run's last recorded action, if it failed. */
function runError(run: WorkflowRun): string | null {
  const last = run.logs.at(-1)
  return last?.error ?? null
}

// The redaction sentinel Core returns for a stored secret (#432): a set-but-hidden
// credential (e.g. a Slack/Google Chat webhook URL) reads back as this, and echoing
// it unchanged on write is understood as "keep the stored value". Must match Core's
// `SECRET_SENTINEL` exactly.
const SECRET_SENTINEL = '__biffo_secret_set__'

// Config-field type -> HTML <input type>. Anything else falls back to text.
function inputType(fieldType: string): string {
  if (fieldType === 'email') return 'email'
  if (fieldType === 'url') return 'url'
  if (fieldType === 'tel') return 'tel'
  return 'text'
}

// action_config values are strings for scalar fields, string lists for a
// `multiselect`, an ordered-parts list for a `parts: true` prompt field
// (ADR-0015), and a structured delivery sub-config for the agent action's
// `delivery` field (ADR-0020). These coerce a value to the shape a given control
// expects, without asserting a type the data may not have.
type ConfigValue = ActionConfigValue
type Config = Record<string, ConfigValue>

// The agent action's delivery sub-config, if this value is one. A bare (non-list)
// object with `type`+`config` is a delivery; everything else (strings, tool
// lists, parts lists) reads as "no delivery" here.
/** A copy of `source` without `key`. Avoids a dynamic `delete`, which the lint
 *  rules ban and which mutates a value other code may still be holding. */
function omit<T extends Record<string, unknown>>(source: T, key: string): T {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key)) as T
}

function asWriteBack(value: ConfigValue | undefined): WriteBackConfigValue | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as unknown as Record<string, unknown>
  if (typeof v.table !== 'string' || v.table === '') return null
  const columns =
    v.columns != null && typeof v.columns === 'object' && !Array.isArray(v.columns)
      ? (v.columns as Record<string, string>)
      : {}
  return {
    table: v.table,
    operation: typeof v.operation === 'string' && v.operation !== '' ? v.operation : 'create',
    columns,
  }
}

/**
 * The plain-language version of a write-back, for the author who is about to
 * enable it. #527 asks for this everywhere; it matters most here, because this
 * is the one field that writes to the database.
 */
function describeWriteBack(
  target: WriteBackTarget | undefined,
  wb: WriteBackConfigValue | null,
  scopeLabel: string,
): string {
  if (target == null || wb == null) return ''
  const chosen = target.columns.filter((c) => wb.columns[c.name] != null)
  if (chosen.length === 0) return `Records nothing yet — choose at least one field to fill.`
  const names = listToProse(chosen.map((c) => c.label))
  const where = scopeLabel !== '' ? ` in ${scopeLabel}` : ''
  if (wb.operation === 'update') {
    const appended = chosen.filter((c) => c.overwrite === 'append').map((c) => c.label)
    const guarded = chosen.filter((c) => c.overwrite === 'if_empty').map((c) => c.label)
    let how = ''
    if (appended.length > 0)
      how += ` ${listToProse(appended)} is added beneath what is already there.`
    if (guarded.length > 0) how += ` ${listToProse(guarded)} is only filled when empty.`
    return `Updates the ${target.label} this event is about${where}, setting ${names}.${how}`
  }
  return `Creates a ${target.label}${where}, setting ${names}.`
}

function asDelivery(value: ConfigValue | undefined): DeliveryConfigValue | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  // A non-array object is no longer *only* delivery-shaped — the write-back
  // sub-config (ADR-0027) is one too — so this narrows on the delivery keys
  // rather than on "is an object", and doubles as the guard against malformed
  // stored data it always was.
  const v = value as unknown as Record<string, unknown>
  return typeof v.type === 'string' && typeof v.config === 'object' && v.config !== null
    ? (value as DeliveryConfigValue)
    : null
}

function asString(value: ConfigValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

// "a, b and c" — for the "Add … to run the test" hint. Deliberately simple and
// deterministic (no Intl.ListFormat) so the copy is stable across locales/tests.
function listToProse(items: string[]): string {
  if (items.length <= 1) return items.join('')
  const last = items[items.length - 1] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${last}`
}

function asList(value: ConfigValue | undefined): string[] {
  // Only the string members of a list (the multiselect/tools case). A parts
  // list is never read through here — parts fields render via their own branch.
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// A field's effective value: what's configured, else the catalog default. Only
// meaningful for scalar fields; a list value (multiselect) reads as unset here.
function effectiveValue(fields: CatalogActionField[], config: Config, name: string): string {
  const value = config[name]
  if (typeof value === 'string' && value !== '') return value
  return fields.find((f) => f.name === name)?.default ?? ''
}

// Conditional fields (e.g. WhatsApp's template config) only render when the
// field they depend on holds the matching value.
function fieldApplies(
  fields: CatalogActionField[],
  config: Config,
  field: CatalogActionField,
): boolean {
  const condition = field.visible_when
  if (condition == null) return true
  return effectiveValue(fields, config, condition.field) === condition.equals
}

// The destinations an agent-action delivery may target (ADR-0020, #527), in the
// order the selector offers them. Each is a standalone destination action; the
// delivery sub-form is driven by that action's own `config_fields` — reused, not
// duplicated. `''` is the default "None" (no delivery) selection.
const DELIVERY_TYPES = ['email', 'slack', 'google_chat', 'whatsapp'] as const
const DELIVERY_LABEL: Record<string, string> = {
  email: 'Email',
  slack: 'Slack',
  google_chat: 'Google Chat',
  whatsapp: 'WhatsApp',
}

// How a config-field control reads and writes its value. The agent/other-action
// forms bind this to the top-level `config`; the delivery sub-form binds it to
// `config.delivery.config`, so one renderer serves both without a second copy.
interface FieldContext {
  config: Config
  fields: CatalogActionField[]
  setField: (name: string, update: (prev: ConfigValue | undefined) => ConfigValue) => void
  // The "✨ Draft with AI" affordance only makes sense for the agent's top-level
  // prompt parts — never inside a delivery sub-config.
  allowAssist: boolean
}

// The synthetic config field name the tool picker writes into action_config.
// Deliberately NOT a Core config_field (Core keeps tools out of config_fields);
// the builder injects it from the action's `available_tools`.
const TOOLS_FIELD = 'tools'

// The web-search tool by name — the only runtime tool today, checked by name
// deliberately (not generalised to hypothetical future web tools).
const WEB_SEARCH_TOOL = 'web_search'

// A model whose string ends in `:online` (the OpenRouter convention) performs
// web search at the provider; the web_search tool performs it again in the
// runtime. Both on one worker double the web injection — worth flagging, but
// only informational, never a save-time block. Keyed off the `:online` suffix,
// not a model name, so it covers any future web-connected model.
function webSearchIsRedundant(config: Config): boolean {
  return (
    asString(config.model).endsWith(':online') && asList(config.tools).includes(WEB_SEARCH_TOOL)
  )
}

// The agent action's tool picker, built from the tools the runtime declared. A
// `multiselect` whose options come from `available_tools`, so it always mirrors
// what the runtime actually registered — never a hardcoded list. Absent/empty
// available_tools yields no field (the picker simply doesn't render).
function toolsField(action: CatalogAction | undefined): CatalogActionField | null {
  const tools = action?.available_tools ?? []
  if (tools.length === 0) return null
  return {
    name: TOOLS_FIELD,
    label: 'Tools',
    type: 'multiselect',
    required: false,
    options: tools.map((t) => ({ value: t.name, label: t.name, description: t.description })),
  }
}

// The config fields the builder actually renders for an action: its Core-declared
// fields, plus the injected tools multiselect when the action carries
// available_tools. Used everywhere the field list drives behaviour (render,
// applicability, and the save filter) so the tools value round-trips.
//
// Core now declares its OWN `tools` config_field too (ADR-0014 §7, #569) — but
// purely for authoring-time validation server-side; it carries no `options`,
// since Core has no live view of what the runtime registered. Drop it here so
// exactly one control renders: the picker built below from `available_tools`,
// which does have live options (with descriptions). Both write the same
// `action_config.tools` key, so nothing about the save path changes.
/** Config-field types that have a dedicated section and must never be drawn as a
 *  generic input. Keep in step with the sections below. */
const STRUCTURED_FIELD_TYPES = new Set(['delivery', 'writeback', 'output_tools'])

function configFieldsFor(action: CatalogAction | undefined): CatalogActionField[] {
  const base = (action?.config_fields ?? []).filter((f) => f.name !== TOOLS_FIELD)
  const tools = toolsField(action)
  return tools == null ? base : [...base, tools]
}

// A select's options, guaranteeing the current value is always among them. A
// stored value outside the curated list (e.g. an agent's model that predates the
// list) is prepended so it stays visible and selected — otherwise the browser
// would silently reassign the select to its first option on load.
function selectOptions(
  field: CatalogActionField,
  current: string,
): { value: string; label: string }[] {
  const options = field.options ?? []
  if (current !== '' && !options.some((o) => o.value === current)) {
    return [{ value: current, label: `${current} (current)` }, ...options]
  }
  return options
}

// Seed a freshly-chosen action's config with its catalog defaults, so what the
// form shows is what gets saved.
function defaultConfig(action: CatalogAction | undefined): Config {
  const config: Config = {}
  for (const field of action?.config_fields ?? []) {
    if (field.default != null) config[field.name] = field.default
  }
  return config
}

// The agent action's outcome journey (issue #527) reframes its config fields.
// These names live under **Advanced settings** (models, turns, the raw prompt,
// and the capability picker) — everything else is a task-shaped Outcome field.
const AGENT_ADVANCED_FIELDS = new Set(['model', 'max_turns', 'instructions', TOOLS_FIELD])

// Task-oriented display labels for the agent action's fields (the brief's
// "Capabilities" not "Tools", "Result" not "Goals"). Anything not listed keeps
// its catalog label.
const AGENT_FIELD_LABEL: Record<string, string> = {
  [TOOLS_FIELD]: 'Capabilities',
  goals: 'Result',
}

function agentLabel(field: CatalogActionField): string {
  return AGENT_FIELD_LABEL[field.name] ?? field.label
}

// A prompt field's value coerced for the dry-run request: a stored parts list
// stays a parts list (dropping anything malformed); anything else is the plain
// string (the pre-library shape). Core accepts either (ADR-0015 §2).
function toPromptField(value: ConfigValue | undefined): string | PromptPart[] {
  return Array.isArray(value) ? normalizeParts(value) : asString(value)
}

// Whether a prompt field carries at least one non-empty part — the required
// check for "instructions" (and the test/enable gate) without asserting a shape.
function promptHasContent(value: ConfigValue | undefined): boolean {
  return normalizeParts(value).some((part) =>
    isInlinePart(part) ? part.inline.trim() !== '' : part.component.trim() !== '',
  )
}

/**
 * What the Test panel shows once a preview run terminates.
 *
 * Derived from the run rather than returned by the dry-run call: the call only
 * queues the work (#726), so everything displayable arrives on the run row.
 */
interface DryRunOutcome {
  runId: string
  output: string
  /** Set when the agent answered through an output tool — the typed columns a
   *  write-back WOULD have written, which is the more useful preview for a
   *  write-back workflow and the thing the dry run deliberately did not do. */
  result: Record<string, unknown> | null
  model: string | null
  costUsd: number | null
}

/** Terminal states, from the run lifecycle (ADR-0014 §6). */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed'])

const DRY_RUN_POLL_INTERVAL_MS = 2_000
/** Generous on purpose: a research agent legitimately runs for minutes (#726),
 *  so this exists to end a *stuck* run, not a slow one. */
const DRY_RUN_POLL_TIMEOUT_MS = 5 * 60_000

/**
 * Thrown when a poll is superseded — a second test started, or the panel moved
 * on. Carries no message because nothing should render it: it means "these
 * results are no longer wanted", not "something went wrong".
 */
class AbandonedPoll extends Error {}

/**
 * The agent's prose answer: the last assistant message carrying content.
 *
 * Read from the back because a tool-using run ends with assistant/tool pairs and
 * only the final assistant turn is the answer. Empty string when the model
 * answered purely through an output tool, in which case `result` is the preview
 * and the panel shows that instead.
 */
function outputFromRun(run: AgentRunResponse): string {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i]
    if (
      message?.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content !== ''
    ) {
      return message.content
    }
  }
  return ''
}

export default function OrchestrationPage() {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [workflows, setWorkflows] = useState<WorkflowDefinition[] | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null)
  // Library components available to reference from a parts field (ADR-0015).
  // Sourced from the prompt-library CRUD API, NOT the action catalog. A fetch
  // failure leaves this [] so the parts editor still renders (unknown refs warn).
  const [components, setComponents] = useState<PromptComponent[]>([])
  const [error, setError] = useState<string | null>(null)

  // Form state (create by default; `editingId` non-null while editing a row).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [triggerKey, setTriggerKey] = useState('')
  const [triggerQuery, setTriggerQuery] = useState('')
  const [actionType, setActionType] = useState('')
  const [config, setConfig] = useState<Config>({})
  const [filterRows, setFilterRows] = useState<FilterRow[]>([])
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  // Timing (docs/implementation/0002-scheduled-workflow-actions): an optional
  // delay before the action fires, e.g. a follow-up email 2 weeks after
  // onboarding. `scheduleEnabled` toggles between "run immediately" (the
  // default, unchanged behaviour) and "run after a delay"; value+unit convert
  // to delay_seconds on save.
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleValue, setScheduleValue] = useState('2')
  const [scheduleUnit, setScheduleUnit] = useState<ScheduleUnit>('weeks')

  // Scope (docs/implementation/0003-hierarchy-scoped-workflows): an optional
  // hierarchy level+id this rule is restricted to, e.g. "Brand X" — covering
  // that brand's regions/units too, not just exact-level events. Deliberately
  // a generic level-select + free-text id here (no name lookup, no tree) —
  // the polished, hierarchy-aware picker is a sibling's job (tabsii-crm#100);
  // this is the same "advanced, optional" pattern as Timing above.
  const [scopeEnabled, setScopeEnabled] = useState(false)
  const [scopeLevel, setScopeLevel] = useState('')
  const [scopeId, setScopeId] = useState('')

  // Which agent parts field the "✨ Draft with AI" drawer is open for, if any
  // (the config field name, e.g. 'instructions' | 'goals'). null = closed.
  const [assistField, setAssistField] = useState<string | null>(null)

  // Collapsible sections of the agent journey. Conditions and Advanced start
  // collapsed — the outcome, not the architecture, leads.
  const [conditionsOpen, setConditionsOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)

  // ── Test & review (Phase 2) ──────────────────────────────────────────────
  // The editable sample event the dry-run runs against, as JSON text. Seeded
  // from the selected trigger's declared fields (#505) and re-seeded when the
  // trigger changes.
  const [sampleEventText, setSampleEventText] = useState('{}')
  const [testing, setTesting] = useState(false)
  const [dryRunResult, setDryRunResult] = useState<DryRunOutcome | null>(null)
  // A retryable failure: 422 unresolvable parts, a bad sample, or a run that
  // came back `failed`. The author can fix and retry.
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  // The run being watched, surfaced while it is in flight. An agent can take
  // minutes (#726), so "testing…" alone would look indistinguishable from a
  // hang — the id gives the author something to open in Agent Runs.
  const [dryRunPending, setDryRunPending] = useState<{ runId: string; status: string } | null>(null)
  // Identifies the in-flight poll. A new test replaces it, which is how the
  // previous poll learns to stop without a cancellation API.
  const pollRef = useRef<object | null>(null)
  // The definition snapshot that last passed a test this session. The Enable
  // gate holds only while the current definition still matches it — editing any
  // config/trigger/condition invalidates the pass automatically (see below).
  // NOTE: this is session-only. Persisting a `tested` flag on the definition is
  // a future refinement; it would need a Core field and is out of scope here.
  const [testedSnapshot, setTestedSnapshot] = useState<string | null>(null)

  const clearTestState = useCallback(() => {
    setTesting(false)
    setDryRunResult(null)
    setDryRunError(null)
    setDryRunPending(null)
    setTestedSnapshot(null)
  }, [])

  const resetForm = useCallback(
    (cat: WorkflowCatalog | null) => {
      setEditingId(null)
      setName('')
      const t = cat?.triggers[0]
      setTriggerKey(t ? triggerKeyOf(t) : '')
      setTriggerQuery('')
      setActionType(cat?.actions[0]?.type ?? '')
      setConfig(defaultConfig(cat?.actions[0]))
      setFilterRows([])
      setEnabled(true)
      setConditionsOpen(false)
      setAdvancedOpen(false)
      setScheduleEnabled(false)
      setScheduleValue('2')
      setScheduleUnit('weeks')
      setTimingOpen(false)
      setScopeEnabled(false)
      setScopeLevel(cat?.scope_levels[0] ?? '')
      setScopeId('')
      setScopeOpen(false)
      clearTestState()
    },
    [clearTestState],
  )

  useEffect(() => {
    fetchCatalog(client)
      .then((cat) => {
        setCatalog(cat)
        resetForm(cat)
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
      })
  }, [client, resetForm])

  const reload = useCallback(async () => {
    try {
      const [definitions, history] = await Promise.all([fetchWorkflows(client), fetchRuns(client)])
      setWorkflows(definitions)
      setRuns(history)
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  // Load the referenceable prompt components once. A failure is non-fatal to
  // the builder — the parts editor renders with no options and warns on any
  // unknown reference — so it does not clobber the page-level error banner.
  useEffect(() => {
    fetchPromptComponents(client)
      .then(setComponents)
      .catch(() => {
        setComponents([])
      })
  }, [client])

  // Run a mutation, surface any error, and refresh from the server.
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      await reload()
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }

  const selectedAction: CatalogAction | undefined = catalog?.actions.find(
    (a) => a.type === actionType,
  )
  const isAgent = selectedAction?.type === 'agent'

  // ── Delivery (ADR-0020, #527) ──────────────────────────────────────────────
  // The agent action's optional deliver-on-completion sub-config field, if this
  // catalog declares one (absent on a Core predating Phase 3). Its value is a
  // structured { type, config }; the sub-form is driven by the chosen
  // destination action's own config_fields — reused, never duplicated.
  const writebackField = selectedAction?.config_fields.find((f) => f.type === 'writeback')
  const writebackTargets = catalog?.writeback_targets ?? []
  const writeback = writebackField != null ? asWriteBack(config[writebackField.name]) : null
  const writebackTarget = writebackTargets.find((t) => t.table === writeback?.table)

  const deliveryField = selectedAction?.config_fields.find((f) => f.type === 'delivery')
  const delivery = deliveryField != null ? asDelivery(config[deliveryField.name]) : null
  const deliveryAction = catalog?.actions.find((a) => a.type === delivery?.type)
  const deliveryFields = deliveryAction?.config_fields ?? []
  const deliveryConfig: Config = delivery?.config ?? {}

  // A selected delivery is valid only when every applicable required field is
  // filled — except `output_body`, which is optional in a delivery (defaults to
  // `{output}`). A secret's redaction sentinel counts as filled (kept-on-save),
  // and a catalog default satisfies a required field, mirroring standalone-action
  // validation. No destination selected ⇒ trivially valid.
  const deliveryValid =
    delivery == null ||
    (deliveryAction != null &&
      deliveryFields.every((f) => {
        if (!fieldApplies(deliveryFields, deliveryConfig, f)) return true
        if (!f.required || f.output_body === true) return true
        return effectiveValue(deliveryFields, deliveryConfig, f.name).trim() !== ''
      }))

  const selectedTrigger: CatalogTrigger | undefined = catalog?.triggers.find(
    (t) => triggerKeyOf(t) === triggerKey,
  )

  // The selected trigger's declared payload fields (#505). Drives both the "Only
  // when…" condition dropdowns and the seeded sample event; empty (observed
  // events, or a Core API predating the metadata) falls back to free text / an
  // empty sample the author fills in.
  const triggerFields: CatalogTriggerField[] = selectedTrigger?.fields ?? []
  const hasTriggerFields = triggerFields.length > 0

  // Re-seed the editable sample event whenever the selected trigger changes, so
  // "Test workflow" starts from a realistic payload for that event (#505). The
  // sample is test-only input — not persisted, and not part of the enable gate.
  useEffect(() => {
    // `selectedTrigger` is a stable reference from the catalog array, so this
    // re-seeds only when the chosen trigger actually changes.
    setSampleEventText(formatSampleEvent(buildSampleEvent(selectedTrigger?.fields ?? [])))
  }, [selectedTrigger])

  // The filter narrows the dropdown but never drops the current selection —
  // otherwise the browser would silently reassign the select's value.
  const triggerGroups = useMemo(
    () => groupTriggersBySource(filterTriggers(catalog?.triggers ?? [], triggerQuery, triggerKey)),
    [catalog, triggerQuery, triggerKey],
  )

  const matchCount = useMemo(
    () => filterTriggers(catalog?.triggers ?? [], triggerQuery).length,
    [catalog, triggerQuery],
  )

  // The identity of the workflow definition as it would be saved. The Enable
  // gate is valid only while this still equals the snapshot that last passed a
  // test — so any edit to the config/trigger/conditions invalidates the pass
  // (the sample event is deliberately excluded: it is test input, not config).
  const definitionSnapshot = useMemo(
    () => JSON.stringify({ name, triggerKey, actionType, config, filterRows }),
    [name, triggerKey, actionType, config, filterRows],
  )
  const testPassed = testedSnapshot != null && testedSnapshot === definitionSnapshot

  // Agent required-field validity for the gate: a name, an agent name, and some
  // instructions. (Model has a catalog default; the sample is optional.)
  const missingForTest = [
    name.trim() === '' ? 'a workflow name' : null,
    asString(config.agent_name).trim() === '' ? 'an agent name' : null,
    !promptHasContent(config.instructions) ? 'instructions' : null,
  ].filter((m): m is string => m != null)
  const agentRequiredValid = missingForTest.length === 0

  // "Test workflow" stays clickable even when required fields are missing — a
  // dead button leaves the author guessing. `runTest` short-circuits with a
  // message naming exactly what to add (issue #527 UX). Only `isAgent` (a
  // non-agent action has no dry-run) and `!testing` gate the click itself.
  //
  // Testing is a no-side-effect output preview and never performs delivery
  // (ADR-0020), so delivery validity is deliberately NOT part of `canTest` —
  // only of `canEnable`, the gate on actually turning the workflow on.
  const canTest = isAgent && !testing
  const canEnable = isAgent && agentRequiredValid && deliveryValid && testPassed && !busy

  function loadForEdit(w: WorkflowDefinition) {
    setEditingId(w.id)
    setName(w.name)
    setTriggerKey(`${w.trigger_source}|${w.trigger_detail_type}`)
    setTriggerQuery('')
    setActionType(w.action_type)
    setConfig({ ...w.action_config })
    setFilterRows(toFilterRows(w.trigger_filter))
    setEnabled(w.enabled)
    setConditionsOpen(Object.keys(w.trigger_filter ?? {}).length > 0)
    setAdvancedOpen(false)
    if (w.schedule_config != null) {
      const { value, unit } = secondsToScheduleValue(w.schedule_config.delay_seconds)
      setScheduleEnabled(true)
      setScheduleValue(value)
      setScheduleUnit(unit)
      setTimingOpen(true)
    } else {
      setScheduleEnabled(false)
      setScheduleValue('2')
      setScheduleUnit('weeks')
      setTimingOpen(false)
    }
    if (w.scope != null) {
      setScopeEnabled(true)
      setScopeLevel(w.scope.level)
      setScopeId(w.scope.id)
      setScopeOpen(true)
    } else {
      setScopeEnabled(false)
      setScopeLevel(catalog?.scope_levels[0] ?? '')
      setScopeId('')
      setScopeOpen(false)
    }
    clearTestState()
  }

  async function submitForm(enabledValue: boolean) {
    if (busy) return
    const [trigger_source, trigger_detail_type] = triggerKey.split('|')
    // Save only the fields that apply, so switching e.g. WhatsApp text →
    // template doesn't leave the abandoned branch's values in action_config.
    // configFieldsFor (not raw config_fields) so the injected tools multiselect
    // is recognised and its list value round-trips.
    const fields = configFieldsFor(selectedAction)
    let applicable = Object.fromEntries(
      Object.entries(config).filter((entry) =>
        fields.some((f) => f.name === entry[0] && fieldApplies(fields, config, f)),
      ),
    )
    // Prune abandoned conditional branches from a delivery sub-config too, so
    // switching e.g. WhatsApp text → template inside a delivery doesn't leave the
    // old branch's values behind — the same filter the top-level config gets.
    if (deliveryField != null && delivery != null) {
      applicable[deliveryField.name] = {
        type: delivery.type,
        config: Object.fromEntries(
          Object.entries(delivery.config).filter(([key]) =>
            deliveryFields.some(
              (f) => f.name === key && fieldApplies(deliveryFields, delivery.config, f),
            ),
          ),
        ),
      }
    }
    // The write-back is structured, so it round-trips as an object rather than
    // through the generic field filter. Only the columns the author actually
    // chose are sent — an unchecked column must not arrive as an empty mapping,
    // which Core would read as "fill this with nothing".
    if (writebackField != null) {
      if (writeback != null && Object.keys(writeback.columns).length > 0) {
        applicable[writebackField.name] = {
          table: writeback.table,
          operation: writeback.operation,
          columns: writeback.columns,
        }
      } else {
        // Omitted rather than emptied: an unchecked write-back must not arrive
        // as an empty mapping, which Core reads as "fill this with nothing".
        applicable = omit(applicable, writebackField.name)
      }
    }
    const delaySeconds = scheduleEnabled ? scheduleDelaySeconds(scheduleValue, scheduleUnit) : null
    const body: WorkflowInput = {
      name: name.trim(),
      trigger_source: trigger_source ?? '',
      trigger_detail_type: trigger_detail_type ?? '',
      trigger_filter: toTriggerFilter(filterRows),
      action_type: actionType,
      action_config: applicable,
      enabled: enabledValue,
      schedule_config:
        delaySeconds != null ? { type: 'fixed_delay', delay_seconds: delaySeconds } : null,
      scope:
        scopeEnabled && scopeLevel.trim() !== '' && scopeId.trim() !== ''
          ? { level: scopeLevel, id: scopeId.trim() }
          : null,
    }
    setBusy(true)
    try {
      await run(async () => {
        if (editingId != null) {
          await updateWorkflow(client, editingId, body)
        } else {
          await createWorkflow(client, body)
        }
        resetForm(catalog)
      })
    } finally {
      setBusy(false)
    }
  }

  // The Maximum-turns config value as a positive integer, or null when unset.
  function maxTurnsValue(): number | null {
    const raw = asString(config.max_turns).trim()
    if (raw === '') return null
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 1 ? n : null
  }

  // "Test workflow" — the no-side-effect dry-run (Phase 2). Runs one agent turn
  // against the sample event and previews the output; a success marks the
  // current definition snapshot as tested, which is what unlocks Enable.
  async function runTest() {
    if (testing) return
    // Clickable-but-incomplete: tell the author exactly what to add rather than
    // silently doing nothing (issue #527 UX).
    if (!agentRequiredValid) {
      setDryRunError(`Add ${listToProse(missingForTest)} to run the test.`)
      setDryRunResult(null)
      setDryRunPending(null)
      return
    }
    const parsed = parseSampleEvent(sampleEventText)
    if (parsed.error != null) {
      setDryRunError(parsed.error)
      setDryRunResult(null)
      setDryRunPending(null)
      return
    }
    const [source, detail_type] = triggerKey.split('|')
    const turns = maxTurnsValue()
    const request: WorkflowDryRunRequest = {
      agent_name: asString(config.agent_name),
      instructions: toPromptField(config.instructions),
      sample_event: parsed.event,
      ...(config.goals != null ? { goals: toPromptField(config.goals) } : {}),
      ...(asString(config.model) !== '' ? { model: asString(config.model) } : {}),
      ...(turns != null ? { max_turns: turns } : {}),
      ...(source != null && source !== '' && detail_type != null && detail_type !== ''
        ? { trigger: { source, detail_type } }
        : {}),
    }
    setTesting(true)
    setDryRunError(null)
    setDryRunResult(null)
    // Snapshot captured before the await so a passing test binds to the config
    // that was actually tested.
    const snapshotAtSend = definitionSnapshot
    // Claimed before the first await. Every state write below is guarded on
    // still owning it, so a test started while this one is in flight is not
    // overwritten by the older run's result, error, or its `finally`.
    const token = {}
    pollRef.current = token
    try {
      const accepted = await startWorkflowDryRun(client, request)
      if (pollRef.current !== token) return
      setDryRunPending({ runId: accepted.run_id, status: accepted.status })
      const run = await pollUntilTerminal(accepted.run_id, token)
      if (run.status === 'failed') {
        // The run terminated honestly; show why. Distinct from a request that
        // never started, which throws above.
        setDryRunError(run.error ?? 'The agent run failed.')
        return
      }
      setDryRunResult({
        runId: run.id,
        output: outputFromRun(run),
        result: run.result,
        // Read off the snapshot rather than the request: this is the model the
        // run actually executed with, including Core's default when none was set.
        model:
          typeof run.definition_snapshot['model'] === 'string'
            ? run.definition_snapshot['model']
            : null,
        costUsd: run.cost_usd,
      })
      setTestedSnapshot(snapshotAtSend)
    } catch (err: unknown) {
      // A superseded poll is not a failure — a newer test owns the panel now, so
      // reporting this one would overwrite its state with stale bad news.
      if (err instanceof AbandonedPoll || pollRef.current !== token) return
      // 422 (unresolvable parts), a poll that gave up, or a transport failure.
      // The old 502/503 branches are gone with the synchronous invoke: there is
      // no in-request runtime call left to fail or to be unconfigured.
      setDryRunError(detailOf(err))
    } finally {
      // Only the owning invocation clears the busy state — otherwise a
      // superseded poll would switch the button back on mid-test.
      if (pollRef.current === token) {
        pollRef.current = null
        setTesting(false)
        setDryRunPending(null)
      }
    }
  }

  /**
   * Poll a preview run until it terminates.
   *
   * Bounded rather than open-ended: a runtime that never claims the run would
   * otherwise leave this polling for the life of the page. The cap is generous
   * because the whole point of #726 is that a real agent may legitimately take
   * minutes — it exists to end a *stuck* run, not a slow one, and it says so
   * rather than reporting a false failure.
   *
   * `token` is re-checked each tick so starting a second test abandons the first
   * quietly instead of racing it into the panel.
   */
  async function pollUntilTerminal(runId: string, token: object): Promise<AgentRunResponse> {
    const deadline = Date.now() + DRY_RUN_POLL_TIMEOUT_MS
    for (;;) {
      // Read before sleeping: a fast agent should return at once rather than
      // paying a fixed interval for nothing.
      if (pollRef.current !== token) throw new AbandonedPoll()
      const run = await fetchAgentRun(client, runId)
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run
      setDryRunPending({ runId, status: run.status })
      if (Date.now() > deadline) {
        throw new Error(
          `The run has not finished after ${String(Math.round(DRY_RUN_POLL_TIMEOUT_MS / 60000))} minutes ` +
            `and is still “${run.status}”. It may still complete — open run ${runId} in Agent Runs to follow it.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, DRY_RUN_POLL_INTERVAL_MS))
    }
  }

  function triggerLabel(w: WorkflowDefinition): string {
    const match = catalog?.triggers.find(
      (t) => triggerKeyOf(t) === `${w.trigger_source}|${w.trigger_detail_type}`,
    )
    return match?.label ?? `${w.trigger_source} / ${w.trigger_detail_type}`
  }

  // Plain-language recap of what the workflow will do — shown in the action bar
  // so the author always sees the whole in one sentence.
  const planSummary = (() => {
    const when = selectedTrigger?.label ?? 'a matching event happens'
    const agentName = asString(config.agent_name).trim()
    const who = agentName !== '' ? `“${agentName}”` : 'your agent'
    return `When ${when}, run ${who} and preview the result before it goes live.`
  })()

  // ── one config-field control, shared by the non-agent form, the agent
  //    journey's Outcome/Advanced sections, AND the delivery sub-form. `ctx`
  //    binds it to a config source (top-level `config`, or the nested delivery
  //    config) so the same renderer serves every case without a second copy.
  //    `labelOverride` gives the agent journey its task-oriented labels without
  //    changing the saved field name. ──
  function fieldControl(field: CatalogActionField, ctx: FieldContext, labelOverride?: string) {
    const label = labelOverride ?? field.label
    const { config: cfg, fields, setField } = ctx
    if (field.parts === true) {
      return (
        <div key={field.name} className="sm:col-span-2">
          <PartsField
            label={label}
            required={field.required}
            components={components}
            value={normalizeParts(cfg[field.name])}
            onChange={(parts) => {
              setField(field.name, () => parts)
            }}
          />
          {ctx.allowAssist && (
            <button
              type="button"
              onClick={() => {
                setAssistField(field.name)
              }}
              className="mt-2 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              ✨ Draft {label} with AI
            </button>
          )}
        </div>
      )
    }
    if (field.type === 'multiselect') {
      return (
        <fieldset
          key={field.name}
          aria-label={label}
          className="flex flex-col text-xs text-gray-600 sm:col-span-2"
        >
          <legend className="text-xs text-gray-600">{label}</legend>
          <div className="mt-1 space-y-1.5 rounded border px-2 py-2">
            {(field.options ?? []).map((option) => {
              const selected = asList(cfg[field.name])
              return (
                <label key={option.value} className="flex items-start gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.includes(option.value)}
                    onChange={(e) => {
                      setField(field.name, (prev) => {
                        const current = asList(prev)
                        return e.target.checked
                          ? [...current, option.value]
                          : current.filter((v) => v !== option.value)
                      })
                    }}
                  />
                  <span>
                    <span className="font-medium">{option.value}</span>
                    {option.description != null && option.description !== '' && (
                      <span className="block text-xs text-gray-500">{option.description}</span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    }
    return (
      <label
        key={field.name}
        className={`flex flex-col text-xs text-gray-600 ${
          field.type === 'textarea' ? 'sm:col-span-2' : ''
        }`}
      >
        {label}
        {field.type === 'textarea' ? (
          <textarea
            value={asString(cfg[field.name])}
            required={field.required}
            onChange={(e) => {
              setField(field.name, () => e.target.value)
            }}
            rows={3}
            className={inputClass}
          />
        ) : field.type === 'select' ? (
          <select
            aria-label={label}
            value={effectiveValue(fields, cfg, field.name)}
            onChange={(e) => {
              setField(field.name, () => e.target.value)
            }}
            className={inputClass}
          >
            {selectOptions(field, effectiveValue(fields, cfg, field.name)).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            // While a secret field still shows the redaction sentinel, relax the
            // input to plain text: an opaque marker (or an unchanged webhook) must
            // not be rejected by url/email client validation, so it round-trips
            // untouched and Core keeps the stored secret (#432).
            type={
              field.secret === true && asString(cfg[field.name]) === SECRET_SENTINEL
                ? 'text'
                : inputType(field.type)
            }
            value={asString(cfg[field.name])}
            required={field.required}
            onChange={(e) => {
              setField(field.name, () => e.target.value)
            }}
            className={inputClass}
          />
        )}
        {field.payload_template === true && triggerFields.length > 0 && (
          <select
            aria-label={`Insert a trigger field into ${label}`}
            value=""
            onChange={(e) => {
              const chosen = e.target.value
              if (chosen === '') return
              setField(field.name, (prev) => `${asString(prev)}{${chosen}}`)
              e.target.value = ''
            }}
            className="mt-1 self-start rounded border px-1.5 py-1 text-xs text-gray-500"
          >
            <option value="">+ Insert field from payload…</option>
            {triggerFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label} ({f.name})
              </option>
            ))}
          </select>
        )}
      </label>
    )
  }

  // The top-level config context: reads/writes the workflow's own action_config.
  const mainFieldContext: FieldContext = {
    config,
    fields: configFieldsFor(selectedAction),
    setField: (name, update) => {
      setConfig((c) => ({ ...c, [name]: update(c[name]) }))
    },
    allowAssist: true,
  }

  // The "Only when…" condition editor (trigger-aware, #505). Shared by both
  // layouts; the agent journey wraps it in a collapsed disclosure.
  function conditionsEditor() {
    return (
      <div className="mt-2 space-y-2">
        <p className="text-xs text-gray-500">
          Narrow a broad trigger. Every condition must match the event exactly — leave empty to run
          on every one.
        </p>
        <div className="space-y-2">
          {filterRows.map((row, i) => {
            const label = `Condition ${String(i + 1)}`
            // When the trigger declares no fields, the field IS free text —
            // never treat that as a "custom" escape from a known list.
            const isKnownField =
              hasTriggerFields && findTriggerField(triggerFields, row.field) != null
            const chosenField = findTriggerField(triggerFields, row.field)
            const setRow = (patch: Partial<FilterRow>) => {
              setFilterRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
            }
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                {hasTriggerFields ? (
                  <select
                    aria-label={`${label} field`}
                    value={isKnownField ? row.field : CUSTOM_FIELD}
                    onChange={(e) => {
                      if (e.target.value === CUSTOM_FIELD) {
                        setRow({ field: '', value: '' })
                        return
                      }
                      const next = findTriggerField(triggerFields, e.target.value)
                      const keepValue =
                        !isEnumerable(next) || (next?.values.includes(row.value) ?? false)
                      setRow({ field: e.target.value, value: keepValue ? row.value : '' })
                    }}
                    className="rounded border px-2 py-1 text-sm"
                  >
                    {triggerFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label}
                      </option>
                    ))}
                    <option value={CUSTOM_FIELD}>Custom field…</option>
                  </select>
                ) : (
                  <input
                    aria-label={`${label} field`}
                    value={row.field}
                    onChange={(e) => {
                      setRow({ field: e.target.value })
                    }}
                    placeholder="status"
                    className="rounded border px-2 py-1 text-sm"
                  />
                )}
                {hasTriggerFields && !isKnownField && (
                  <input
                    aria-label={`${label} custom field`}
                    value={row.field}
                    onChange={(e) => {
                      setRow({ field: e.target.value })
                    }}
                    placeholder="field name"
                    className="rounded border px-2 py-1 text-sm"
                  />
                )}
                <span className="text-xs text-gray-400">is</span>
                {isEnumerable(chosenField) ? (
                  <select
                    aria-label={`${label} value`}
                    value={row.value}
                    onChange={(e) => {
                      setRow({ value: e.target.value })
                    }}
                    className="rounded border px-2 py-1 text-sm"
                  >
                    <option value="">Choose…</option>
                    {chosenField?.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                    {row.value !== '' && !(chosenField?.values.includes(row.value) ?? false) && (
                      <option value={row.value}>{row.value} (current)</option>
                    )}
                  </select>
                ) : (
                  <input
                    aria-label={`${label} value`}
                    value={row.value}
                    onChange={(e) => {
                      setRow({ value: e.target.value })
                    }}
                    placeholder="won"
                    className="rounded border px-2 py-1 text-sm"
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setFilterRows((rows) => rows.filter((_, j) => j !== i))
                  }}
                  className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            // Seed a new row with the trigger's first field when it has any,
            // so the dropdown starts on a real field rather than "custom".
            setFilterRows((rows) => [...rows, { field: triggerFields[0]?.name ?? '', value: '' }])
          }}
          className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          Add condition
        </button>
      </div>
    )
  }

  const agentFields = configFieldsFor(selectedAction)
  const advancedFields = agentFields.filter((f) => AGENT_ADVANCED_FIELDS.has(f.name))
  const goalsField = agentFields.find((f) => f.name === 'goals')
  const agentNameField = agentFields.find((f) => f.name === 'agent_name')
  // Any other task-shaped agent field the catalog might grow: rendered in the
  // Outcome section (not Advanced) so it is never silently dropped from the UI.
  // `delivery` and `writeback` are excluded here — each has its own section, and
  // must never fall through to a generic text input. A structured sub-config
  // rendered as a text box does not merely look wrong: typing in it puts a
  // *string* where Core expects an object, and the author has two controls for
  // one setting with no clue which wins. Any future structured field type
  // belongs in this list on the same day it is added.
  const otherOutcomeFields = agentFields.filter(
    (f) =>
      !AGENT_ADVANCED_FIELDS.has(f.name) &&
      f.name !== 'goals' &&
      f.name !== 'agent_name' &&
      !STRUCTURED_FIELD_TYPES.has(f.type),
  )
  const redundantWebSearch = isAgent && webSearchIsRedundant(config)

  // The delivery sub-form's config context: reads/writes `config.delivery.config`
  // through the very same field renderer the top-level form uses (never a second
  // copy). A no-op when no delivery is selected — the fields simply aren't shown.
  const deliveryFieldContext: FieldContext = {
    config: deliveryConfig,
    fields: deliveryFields,
    setField: (fieldName, update) => {
      const name = deliveryField?.name
      if (name == null) return
      setConfig((c) => {
        const current = asDelivery(c[name])
        if (current == null) return c
        return {
          ...c,
          [name]: {
            ...current,
            config: { ...current.config, [fieldName]: update(current.config[fieldName]) },
          },
        }
      })
    },
    allowAssist: false,
  }

  // Choose (or clear) the delivery destination. "None" (`''`) removes the whole
  // sub-config so a read sees no delivery; a destination seeds that action's
  // catalog defaults, so what the sub-form shows is what gets saved.
  function setWriteBack(next: WriteBackConfigValue) {
    if (writebackField == null) return
    setConfig((c) => ({ ...c, [writebackField.name]: next }))
  }

  function selectWriteBackTarget(table: string) {
    if (writebackField == null) return
    if (table === '') {
      setConfig((c) => omit(c, writebackField.name))
      return
    }
    const target = writebackTargets.find((t) => t.table === table)
    setWriteBack({
      table,
      // Prefer update when offered: amending the record the event is about is
      // the safer default, and the one an author almost always means.
      operation: target?.operations.includes('update') === true ? 'update' : 'create',
      columns: {},
    })
  }

  function toggleWriteBackColumn(name: string, on: boolean) {
    if (writeback == null) return
    const columns = on
      ? { ...writeback.columns, [name]: `{output.${name}}` }
      : omit(writeback.columns, name)
    setWriteBack({ ...writeback, columns })
  }

  function selectDelivery(type: string) {
    const name = deliveryField?.name
    if (name == null) return
    if (type === '') {
      // Drop the delivery key entirely so a read sees no delivery (absent, not an
      // empty object). Rebuilt without the key rather than a dynamic `delete`.
      setConfig((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== name)))
      return
    }
    const dest = catalog?.actions.find((a) => a.type === type)
    setConfig((c) => ({ ...c, [name]: { type, config: defaultConfig(dest) } }))
  }

  // Apply a guided preset: seed starter instructions + result the author refines.
  function applyPreset(presetId: string) {
    const preset = OUTCOME_PRESETS.find((p) => p.id === presetId)
    if (preset == null) return
    setConfig((c) => ({
      ...c,
      instructions: [{ inline: preset.instructions }],
      // Only seed the result when the action actually has a goals field.
      ...(goalsField != null ? { goals: [{ inline: preset.result }] } : {}),
    }))
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
      <p className="mt-1 text-sm text-gray-600">
        Automate follow-ups: when an event happens, run an action. Create a workflow below and it
        takes effect on the next matching event — no deploy needed.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {catalog != null && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            // The primary submit saves: a draft for the agent journey (Enable is
            // its own gated button), or the enabled-checkbox value otherwise.
            void submitForm(isAgent ? false : enabled)
          }}
          className="mt-6 rounded-xl border bg-white p-4 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-900">
            {editingId != null ? 'Edit workflow' : 'New workflow'}
          </h2>

          {/* ── Workflow details ─────────────────────────────────────────── */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col text-xs text-gray-600">
              Name
              <input
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                }}
                placeholder="Notify the sales team"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col text-xs text-gray-600">
              Do this (action)
              <select
                aria-label="Action"
                value={actionType}
                onChange={(e) => {
                  setActionType(e.target.value)
                  setConfig(defaultConfig(catalog.actions.find((a) => a.type === e.target.value)))
                  setAdvancedOpen(false)
                  clearTestState()
                }}
                className={inputClass}
              >
                {catalog.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            {isAgent ? (
              <p className="self-end text-xs text-gray-500">
                Status:{' '}
                {editingId != null && enabled ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">
                    enabled
                  </span>
                ) : (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">draft</span>
                )}
                <span className="ml-1">— enable it below once a test passes.</span>
              </p>
            ) : (
              <label className="flex items-center gap-2 self-end text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked)
                  }}
                />
                Enabled
              </label>
            )}
          </div>

          {/* ── Trigger ──────────────────────────────────────────────────── */}
          <div className="mt-4 rounded-lg border border-gray-200 p-3">
            <h3 className="text-xs font-semibold text-gray-700">When this happens (trigger)</h3>
            <div className="mt-2 flex flex-col text-xs text-gray-600">
              <label className="flex flex-col">
                Filter triggers
                <input
                  type="search"
                  aria-label="Filter triggers"
                  value={triggerQuery}
                  onChange={(e) => {
                    setTriggerQuery(e.target.value)
                  }}
                  placeholder="Search by name, source or event"
                  className={inputClass}
                />
              </label>
              <label className="mt-2 flex flex-col">
                Trigger
                <select
                  aria-label="Trigger"
                  value={triggerKey}
                  onChange={(e) => {
                    setTriggerKey(e.target.value)
                  }}
                  className={inputClass}
                >
                  {triggerGroups.map((group) => (
                    <optgroup key={group.source} label={group.source}>
                      {group.triggers.map((t) => (
                        <option key={triggerKeyOf(t)} value={triggerKeyOf(t)} title={t.description}>
                          {optionLabel(t)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {triggerQuery.trim() !== '' && matchCount === 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  No triggers match “{triggerQuery.trim()}”. Showing the current selection only.
                </p>
              )}
              {selectedTrigger != null && (
                <div className="mt-1.5 flex items-start gap-2">
                  {originOf(selectedTrigger) === 'declared' ? (
                    <span
                      title="Declared in the Core event registry."
                      className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700"
                    >
                      declared
                    </span>
                  ) : (
                    <span
                      title="Not declared anywhere — seen on the event bus."
                      className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700"
                    >
                      observed
                    </span>
                  )}
                  <span className="text-xs text-gray-500">{selectedTrigger.description}</span>
                </div>
              )}
            </div>

            {/* Sample input data (agent journey): what an event of this trigger
                looks like, seeded from its declared fields (#505). Editable in
                Test & review below. */}
            {isAgent && (
              <div className="mt-3 rounded border border-gray-100 bg-gray-50 p-2">
                <p className="text-xs font-medium text-gray-600">Sample input data</p>
                {hasTriggerFields ? (
                  <dl className="mt-1 space-y-0.5">
                    {triggerFields.map((f) => (
                      <div key={f.name} className="flex gap-2 text-xs">
                        <dt className="font-mono text-gray-500">{f.name}</dt>
                        <dd className="text-gray-700">
                          {String(buildSampleEvent(triggerFields)[f.name])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-1 text-xs text-gray-400">
                    This trigger declares no fields — add your own sample below in Test &amp;
                    review.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Conditions ───────────────────────────────────────────────── */}
          {isAgent ? (
            <div className="mt-4 rounded-lg border border-gray-200 p-3">
              <button
                type="button"
                aria-expanded={conditionsOpen}
                onClick={() => {
                  setConditionsOpen((v) => !v)
                }}
                className="flex w-full items-center justify-between text-left text-xs font-semibold text-gray-700"
              >
                <span>Conditions (optional)</span>
                <span aria-hidden="true" className="text-gray-400">
                  {conditionsOpen ? '▲' : '▼'}
                </span>
              </button>
              {conditionsOpen && conditionsEditor()}
            </div>
          ) : (
            <fieldset className="mt-4 rounded-lg border border-gray-200 p-3">
              <legend className="px-1 text-xs font-semibold text-gray-700">
                Only when… (optional)
              </legend>
              {conditionsEditor()}
            </fieldset>
          )}

          {/* ── Timing (advanced, optional) ──────────────────────────────────
              docs/implementation/0002-scheduled-workflow-actions: delay the
              action instead of firing it the instant the trigger arrives —
              e.g. a follow-up email 2 weeks after onboarding. Applies to every
              action type, so it lives here rather than inside the agent-only
              "Advanced settings" disclosure above. */}
          <div className="mt-4 rounded-lg border border-gray-200 p-3">
            <button
              type="button"
              aria-expanded={timingOpen}
              onClick={() => {
                setTimingOpen((v) => !v)
              }}
              className="flex w-full items-center justify-between text-left text-xs font-semibold text-gray-700"
            >
              <span>Timing (advanced, optional)</span>
              <span aria-hidden="true" className="text-gray-400">
                {timingOpen ? '▲' : '▼'}
              </span>
            </button>
            {timingOpen && (
              <div className="mt-2">
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={scheduleEnabled}
                    onChange={(e) => {
                      setScheduleEnabled(e.target.checked)
                    }}
                  />
                  Run after a delay, instead of immediately
                </label>
                {scheduleEnabled && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm text-gray-600">Wait</span>
                    <input
                      type="number"
                      min={1}
                      required
                      aria-label="Delay amount"
                      value={scheduleValue}
                      onChange={(e) => {
                        setScheduleValue(e.target.value)
                      }}
                      className="w-20 rounded border px-2 py-1 text-sm"
                    />
                    <select
                      aria-label="Delay unit"
                      value={scheduleUnit}
                      onChange={(e) => {
                        setScheduleUnit(e.target.value as ScheduleUnit)
                      }}
                      className="rounded border px-2 py-1 text-sm"
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                      <option value="weeks">weeks</option>
                    </select>
                    <span className="text-sm text-gray-600">
                      after this trigger fires, then run the action.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Scope (advanced, optional) ────────────────────────────────────
              docs/implementation/0003-hierarchy-scoped-workflows: restrict
              this rule to one hierarchy level+id (e.g. a brand) — it then also
              covers everything beneath it (that brand's regions/units), not
              just exact-level events. Only offered when the instance has
              registered a hierarchy resolver at all (`scope_levels` non-empty)
              — otherwise there is nothing meaningful to scope to. */}
          {catalog.scope_levels.length > 0 && (
            <div className="mt-4 rounded-lg border border-gray-200 p-3">
              <button
                type="button"
                aria-expanded={scopeOpen}
                onClick={() => {
                  setScopeOpen((v) => !v)
                }}
                className="flex w-full items-center justify-between text-left text-xs font-semibold text-gray-700"
              >
                <span>Scope (advanced, optional)</span>
                <span aria-hidden="true" className="text-gray-400">
                  {scopeOpen ? '▲' : '▼'}
                </span>
              </button>
              {scopeOpen && (
                <div className="mt-2">
                  <label className="flex items-center gap-2 text-sm text-gray-800">
                    <input
                      type="checkbox"
                      checked={scopeEnabled}
                      onChange={(e) => {
                        setScopeEnabled(e.target.checked)
                      }}
                    />
                    Restrict this rule to one part of the hierarchy
                  </label>
                  {scopeEnabled && (
                    <div className="mt-2 flex items-center gap-2">
                      <select
                        aria-label="Scope level"
                        value={scopeLevel}
                        onChange={(e) => {
                          setScopeLevel(e.target.value)
                        }}
                        className="rounded border px-2 py-1 text-sm"
                      >
                        {catalog.scope_levels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        required
                        aria-label="Scope id"
                        placeholder="id"
                        value={scopeId}
                        onChange={(e) => {
                          setScopeId(e.target.value)
                        }}
                        className="w-40 rounded border px-2 py-1 text-sm"
                      />
                      <span className="text-sm text-gray-600">
                        and everything beneath it in the hierarchy.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Outcome (agent) / generic config (other actions) ─────────── */}
          {selectedAction != null && isAgent && (
            <>
              <div className="mt-4 rounded-lg border border-gray-200 p-3">
                <h3 className="text-sm font-semibold text-gray-900">What should the agent do?</h3>
                <p className="mt-0.5 text-xs text-gray-500">
                  Start from a template, then make it yours — by hand or with “✨ Draft with AI”.
                </p>

                {/* Guided presets */}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {OUTCOME_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        applyPreset(preset.id)
                      }}
                      className="rounded-lg border border-gray-200 p-3 text-left hover:border-gray-900 hover:bg-gray-50"
                    >
                      <span className="block text-sm font-medium text-gray-900">
                        {preset.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500">{preset.summary}</span>
                    </button>
                  ))}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {agentNameField != null && fieldControl(agentNameField, mainFieldContext)}
                  {otherOutcomeFields.map((field) =>
                    fieldControl(field, mainFieldContext, agentLabel(field)),
                  )}
                </div>

                {/* "What should the result contain?" — the relabelled goals field. */}
                {goalsField != null && (
                  <div className="mt-4">
                    <h4 className="text-xs font-semibold text-gray-700">
                      What should the result contain?
                    </h4>
                    <p className="text-xs text-gray-500">
                      Describe the output you expect — a brief, a reply, a summary. This guides the
                      agent and is how you’ll judge a good result.
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {fieldControl(goalsField, mainFieldContext, agentLabel(goalsField))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Record the result (ADR-0027) ──────────────────────────── */}
              {writebackField != null && writebackTargets.length > 0 && (
                <div className="mt-4 rounded-lg border border-gray-200 p-3">
                  <h3 className="text-sm font-semibold text-gray-900">Record the result</h3>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Save what the agent finds back into your data. Optional — leave it on “Don’t
                    record” and the result only goes to the destination above.{' '}
                    <strong>This writes as you</strong>, using your own permissions, so it can never
                    do more than you could by hand.
                  </p>

                  <label className="mt-3 flex flex-col text-xs text-gray-600">
                    Record into
                    <select
                      aria-label="Record into"
                      value={writeback?.table ?? ''}
                      onChange={(e) => {
                        selectWriteBackTarget(e.target.value)
                      }}
                      className={inputClass}
                    >
                      <option value="">Don’t record</option>
                      {writebackTargets.map((t) => (
                        <option key={t.table} value={t.table}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {writeback != null && writebackTarget != null && (
                    <>
                      {writebackTarget.operations.length > 1 && (
                        <label className="mt-3 flex flex-col text-xs text-gray-600">
                          Create a new one, or update the existing one?
                          <select
                            aria-label="Write-back operation"
                            value={writeback.operation}
                            onChange={(e) => {
                              setWriteBack({ ...writeback, operation: e.target.value })
                            }}
                            className={inputClass}
                          >
                            {writebackTarget.operations.map((op) => (
                              <option key={op} value={op}>
                                {op === 'update'
                                  ? `Update the ${writebackTarget.label} this event is about`
                                  : `Create a new ${writebackTarget.label}`}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      <p className="mt-3 text-xs font-medium text-gray-700">
                        Which fields should it fill?
                      </p>
                      <div className="mt-1 space-y-2">
                        {writebackTarget.columns.map((col) => {
                          const on = writeback.columns[col.name] != null
                          return (
                            <div key={col.name} className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                id={`wb-${col.name}`}
                                checked={on}
                                onChange={(e) => {
                                  toggleWriteBackColumn(col.name, e.target.checked)
                                }}
                                className="mt-1"
                              />
                              <div className="flex-1">
                                <label
                                  htmlFor={`wb-${col.name}`}
                                  className="text-xs font-medium text-gray-800"
                                >
                                  {col.label}
                                  {col.required && <span className="text-rose-600"> *</span>}
                                  <span className="ml-2 font-normal text-gray-500">
                                    {col.overwrite === 'append'
                                      ? 'added beneath existing text'
                                      : col.overwrite === 'if_empty'
                                        ? 'only when empty'
                                        : 'replaces what is there'}
                                  </span>
                                </label>
                                {on && (
                                  <input
                                    type="text"
                                    aria-label={`${col.label} value`}
                                    value={writeback.columns[col.name] ?? ''}
                                    onChange={(e) => {
                                      setWriteBack({
                                        ...writeback,
                                        columns: {
                                          ...writeback.columns,
                                          [col.name]: e.target.value,
                                        },
                                      })
                                    }}
                                    className={inputClass}
                                  />
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      <p className="mt-2 text-xs text-gray-500">
                        <code>{'{output.<field>}'}</code> takes the value the agent submitted under
                        that name. The agent is asked for exactly these fields and nothing else.
                      </p>

                      {writebackTarget.operations.includes('update') &&
                        writeback.operation === 'update' &&
                        writebackTarget.row_selector != null && (
                          <p className="mt-2 text-xs text-gray-500">
                            The record to update comes from the event’s{' '}
                            <code>{writebackTarget.row_selector}</code> — never from the agent.
                          </p>
                        )}

                      {writebackTarget.scope_levels.length > 0 && !scopeEnabled && (
                        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          Recording into {writebackTarget.label} needs this workflow scoped to a{' '}
                          {writebackTarget.scope_levels.join(' or ')} — set Scope below, or it
                          cannot be saved.
                        </p>
                      )}

                      <p className="mt-3 rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">
                        {describeWriteBack(writebackTarget, writeback, scopeEnabled ? scopeId : '')}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* ── Delivery (ADR-0020, #527) ─────────────────────────────── */}
              {deliveryField != null && (
                <div className="mt-4 rounded-lg border border-gray-200 p-3">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Where should the result go?
                  </h3>
                  <p className="mt-0.5 text-xs text-gray-500">
                    On a successful run, deliver the agent’s result to one destination. Optional —
                    leave it on “None” and the result is just the preview below.
                  </p>

                  <label className="mt-3 flex flex-col text-xs text-gray-600">
                    Destination
                    <select
                      aria-label="Destination"
                      value={delivery?.type ?? ''}
                      onChange={(e) => {
                        selectDelivery(e.target.value)
                      }}
                      className={inputClass}
                    >
                      <option value="">None</option>
                      {DELIVERY_TYPES.filter((t) => catalog.actions.some((a) => a.type === t)).map(
                        (t) => (
                          <option key={t} value={t}>
                            {DELIVERY_LABEL[t] ?? t}
                          </option>
                        ),
                      )}
                    </select>
                  </label>

                  {delivery != null && deliveryAction != null && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {deliveryFields
                        .filter((field) => fieldApplies(deliveryFields, deliveryConfig, field))
                        .map((field) => {
                          // The message/body field is REQUIRED on the standalone
                          // action but OPTIONAL in a delivery: it defaults to the
                          // `{output}` placeholder server-side. Present it as such,
                          // with a hint and the available placeholders.
                          if (field.output_body === true) {
                            return (
                              <div key={field.name} className="sm:col-span-2">
                                {fieldControl(
                                  { ...field, required: false },
                                  deliveryFieldContext,
                                  `${field.label} (optional)`,
                                )}
                                <p className="mt-1 text-xs text-gray-500">
                                  Leave blank to send the agent’s result as-is, or use{' '}
                                  <code className="rounded bg-gray-100 px-1">{'{output}'}</code> to
                                  include it in your own message. Placeholders:{' '}
                                  <code className="rounded bg-gray-100 px-1">{'{output}'}</code>{' '}
                                  <code className="rounded bg-gray-100 px-1">{'{agent}'}</code>{' '}
                                  <code className="rounded bg-gray-100 px-1">{'{run_id}'}</code>{' '}
                                  <code className="rounded bg-gray-100 px-1">{'{status}'}</code>.
                                </p>
                              </div>
                            )
                          }
                          return fieldControl(field, deliveryFieldContext)
                        })}
                      {!deliveryValid && (
                        <p
                          role="status"
                          className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2"
                        >
                          Fill in the destination’s required fields to enable this workflow.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Test & review (Phase 2) ───────────────────────────────── */}
              <div className="mt-4 rounded-lg border border-gray-200 p-3">
                <h3 className="text-sm font-semibold text-gray-900">Test &amp; review</h3>
                <p className="mt-0.5 text-xs text-gray-500">
                  Run the agent once against sample data. This is a no-side-effect preview — nothing
                  is sent, saved or delivered. A passing test is required before you can enable the
                  workflow.
                </p>

                <label className="mt-3 flex flex-col text-xs text-gray-600">
                  Sample input data
                  <textarea
                    aria-label="Sample input data"
                    value={sampleEventText}
                    onChange={(e) => {
                      setSampleEventText(e.target.value)
                    }}
                    rows={5}
                    spellCheck={false}
                    className={`${inputClass} font-mono`}
                  />
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void runTest()
                    }}
                    disabled={!canTest}
                    className="rounded border border-gray-900 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {testing ? 'Testing…' : 'Test workflow'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSampleEventText(formatSampleEvent(buildSampleEvent(triggerFields)))
                    }}
                    className="rounded border px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    Reset sample
                  </button>
                  {testPassed && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                      test passed
                    </span>
                  )}
                </div>

                {dryRunPending != null && (
                  <div
                    role="status"
                    className="mt-3 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800"
                  >
                    Running the agent…{' '}
                    {dryRunPending.status === 'pending' ? 'queued' : dryRunPending.status}. This can
                    take a few minutes for a research agent — you can follow run{' '}
                    <code className="font-mono text-xs">{dryRunPending.runId}</code> in Agent Runs.
                  </div>
                )}
                {dryRunError != null && (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
                  >
                    {dryRunError} You can adjust the sample or config and try again.
                  </div>
                )}
                {dryRunResult != null && (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      Preview output
                    </p>
                    {dryRunResult.output !== '' && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                        {dryRunResult.output}
                      </pre>
                    )}
                    {dryRunResult.result != null && (
                      <div className="mt-2">
                        {/* The typed columns a write-back WOULD have written. The
                            dry run deliberately did not write them, so showing
                            them is the whole point of previewing this workflow. */}
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                          Would write
                        </p>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                          {JSON.stringify(dryRunResult.result, null, 2)}
                        </pre>
                      </div>
                    )}
                    {dryRunResult.output === '' && dryRunResult.result == null && (
                      <p className="mt-1 text-sm text-gray-500">
                        The agent finished without producing any output.
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3 border-t border-emerald-100 pt-2 text-[11px] text-gray-500">
                      {dryRunResult.model != null && dryRunResult.model !== '' && (
                        <span>{dryRunResult.model}</span>
                      )}
                      {dryRunResult.costUsd != null && (
                        <span>${dryRunResult.costUsd.toFixed(4)}</span>
                      )}
                      <span>
                        run <code className="font-mono">{dryRunResult.runId}</code>
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Advanced settings (collapsed) ─────────────────────────── */}
              <div className="mt-4 rounded-lg border border-gray-200 p-3">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => {
                    setAdvancedOpen((v) => !v)
                  }}
                  className="flex w-full items-center justify-between text-left text-xs font-semibold text-gray-700"
                >
                  <span>Advanced settings</span>
                  <span aria-hidden="true" className="text-gray-400">
                    {advancedOpen ? '▲' : '▼'}
                  </span>
                </button>
                {advancedOpen && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-500">
                      The model, turn budget, the raw prompt and the agent’s capabilities. Most
                      workflows never need to change these.
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {advancedFields.map((field) =>
                        fieldControl(field, mainFieldContext, agentLabel(field)),
                      )}
                      {redundantWebSearch && (
                        <p
                          role="status"
                          className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2"
                        >
                          This model is web-connected and already performs web search — the
                          web_search capability is redundant here.
                        </p>
                      )}
                    </div>
                    <p className="mt-3 rounded bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      Approval modes (suggest / approve / auto) and confidence fallbacks are coming
                      in a later phase.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Structured field types are excluded here for the same reason they are
              in the agent form: drawing one as a generic input puts a *string*
              where Core expects an object. This branch renders every non-agent
              action, including `agent_fan_in`, whose `delivery`/`writeback`/
              `output_tools` are all structured. They round-trip untouched on save
              (the save filter keeps any declared field's stored value) — they are
              simply not editable here until each grows its own control. */}
          {selectedAction != null && !isAgent && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {configFieldsFor(selectedAction)
                .filter(
                  (field) =>
                    !STRUCTURED_FIELD_TYPES.has(field.type) &&
                    fieldApplies(configFieldsFor(selectedAction), config, field),
                )
                .map((field) => fieldControl(field, mainFieldContext))}
            </div>
          )}

          {/* ── Persistent primary actions ───────────────────────────────── */}
          {isAgent ? (
            <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 border-t bg-white/95 px-4 py-3 backdrop-blur">
              <p className="text-xs text-gray-600">{planSummary}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded border px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save draft'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runTest()
                  }}
                  disabled={!canTest}
                  className="rounded border border-gray-900 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                >
                  {testing ? 'Testing…' : 'Test workflow'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void submitForm(true)
                  }}
                  disabled={!canEnable}
                  className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  title={
                    !agentRequiredValid
                      ? 'Add a name, agent name and instructions first.'
                      : !deliveryValid
                        ? 'Fill in the delivery destination’s required fields first.'
                        : !testPassed
                          ? 'Run a passing test to enable this workflow.'
                          : undefined
                  }
                >
                  Enable workflow
                </button>
                {editingId != null && (
                  <button
                    type="button"
                    onClick={() => {
                      resetForm(catalog)
                    }}
                    className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                )}
                {!testPassed && agentRequiredValid && (
                  <span className="text-xs text-gray-500">
                    Enable unlocks after a passing test.
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : editingId != null ? 'Save changes' : 'Add workflow'}
              </button>
              {editingId != null && (
                <button
                  type="button"
                  onClick={() => {
                    resetForm(catalog)
                  }}
                  className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </form>
      )}

      {isAgent && assistField != null && (
        <AssistantDrawer
          open
          onClose={() => {
            setAssistField(null)
          }}
          context={{
            kind: assistField === 'goals' ? 'agent-goals' : 'agent-instructions',
            agentName: asString(config.agent_name) || undefined,
            model: asString(config.model) || undefined,
          }}
          onAccept={(text) => {
            const field = assistField
            setConfig((c) => ({
              ...c,
              [field]: [...normalizeParts(c[field]), { inline: text }],
            }))
            setAssistField(null)
          }}
        />
      )}

      {workflows == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading workflows">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {workflows != null && workflows.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No workflows yet</p>
          <p className="mt-1 text-xs text-gray-400">Create one above to get started.</p>
        </div>
      )}

      {workflows != null && workflows.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {workflows.map((w) => (
                <tr key={w.id}>
                  <td className="px-4 py-2 text-gray-800">
                    {w.name}
                    {/* ADR-0027 §2: a workflow that writes runs under a stored
                        principal, so who that is belongs next to the rule, not
                        buried in a detail view. Re-saving or re-enabling it
                        re-binds the principal to whoever did so. */}
                    {w.run_as_kind === 'user' && w.run_as_user_id != null && (
                      <span
                        className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
                        title={`Runs with the permissions of user ${w.run_as_user_id}. Re-saving or re-enabling this workflow re-binds it to whoever does so.`}
                      >
                        runs as {w.run_as_user_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {triggerLabel(w)}
                    {Object.keys(w.trigger_filter ?? {}).length > 0 && (
                      <span
                        className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700"
                        title={Object.entries(w.trigger_filter ?? {})
                          .map(([f, v]) => `${f} is ${v}`)
                          .join(', ')}
                      >
                        filtered
                      </span>
                    )}
                    {w.schedule_config != null && (
                      <span
                        className="ml-1.5 rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700"
                        title={`Waits ${secondsToScheduleValue(w.schedule_config.delay_seconds).value} ${
                          secondsToScheduleValue(w.schedule_config.delay_seconds).unit
                        } after the trigger before running`}
                      >
                        delayed
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{w.action_type}</td>
                  <td className="px-4 py-2">
                    {w.enabled ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          loadForEdit(w)
                        }}
                        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => setWorkflowEnabled(client, w.id, !w.enabled))
                        }}
                        className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        {w.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => deleteWorkflow(client, w.id))
                        }}
                        className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-10 text-lg font-semibold text-gray-900">Recent runs</h2>
      <p className="mt-1 text-sm text-gray-600">
        Every time an event matched a workflow — what fired, when, and whether the action succeeded.
      </p>

      {runs != null && runs.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">Nothing has run yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Runs appear here the next time a matching event fires.
          </p>
        </div>
      )}

      {runs != null && runs.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Workflow</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Outcome</th>
                <th className="px-4 py-2">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatWhen(r.created_at)}
                  </td>
                  <td className="px-4 py-2 text-gray-800">
                    {r.definition_name ?? <span className="text-gray-400">(deleted)</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{r.logs.at(-1)?.action_type ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        runStatusClass[r.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {r.status}
                    </span>
                    {r.status === 'scheduled' && r.scheduled_for != null && (
                      <span className="ml-1.5 text-xs text-gray-500">
                        fires {formatWhen(r.scheduled_for)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-rose-700">{runError(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

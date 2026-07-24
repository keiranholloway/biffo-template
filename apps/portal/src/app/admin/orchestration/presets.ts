/**
 * Guided starter presets for the outcome-oriented agent-workflow builder
 * (issue #527, Phase 1). Instead of confronting a non-technical author with
 * blank `instructions`/`goals` boxes, the Outcome section offers a few
 * outcome-shaped starting points. Picking one seeds sensible starter
 * `instructions` and a `result` (the relabelled `goals`) they can then refine —
 * by hand or with the "✨ Draft with AI" drawer.
 *
 * This table lives in the portal on purpose: it is authoring UX, not Core
 * contract. The seeded values are ordinary author-time strings written into
 * `action_config` as single inline parts (ADR-0015 §2) — nothing here sources a
 * value from runtime/event data.
 */
export interface OutcomePreset {
  /** Stable id, also used as the button's accessible name suffix. */
  id: string
  /** Short outcome-shaped title shown on the card. */
  title: string
  /** One line explaining what the agent will do. */
  summary: string
  /** Starter agent instructions (the "how"). */
  instructions: string
  /** Starter result definition (the "what should the result contain?"). */
  result: string
}

export const OUTCOME_PRESETS: OutcomePreset[] = [
  {
    id: 'research-prospect',
    title: 'Research a prospect',
    summary: 'Gather background on the company or person in the event.',
    instructions:
      'You research inbound prospects. Using the details in the event, find out what the ' +
      'company does, its size and industry, and anything relevant to a first sales ' +
      'conversation. Prefer recent, reputable sources and note where each fact came from.',
    result:
      'A short prospect brief: what the company does, size/industry, one or two recent ' +
      'signals worth mentioning, and a suggested opening angle for outreach.',
  },
  {
    id: 'qualify-lead',
    title: 'Qualify a lead',
    summary: 'Score how well the lead fits and why.',
    instructions:
      'You qualify inbound leads. Weigh the lead against a good-fit customer: role, company ' +
      'size, apparent budget and stated need. Be explicit about what is missing when you are ' +
      'unsure — never invent detail that is not in the event.',
    result:
      'A qualification verdict (strong / worth a look / likely not a fit) with a one-line ' +
      'reason, plus the single most useful follow-up question to ask the lead.',
  },
  {
    id: 'draft-response',
    title: 'Draft a response',
    summary: 'Write a reply the team can send.',
    instructions:
      'You draft replies to inbound messages. Write in a warm, concise, professional voice. ' +
      'Answer what was actually asked, keep it skimmable, and end with a clear next step. Do ' +
      'not promise anything the event does not support.',
    result:
      'A ready-to-send reply: a subject line (if relevant) and a short body, with any ' +
      'placeholders the sender still needs to fill clearly marked.',
  },
  {
    id: 'notify-team',
    title: 'Notify a team',
    summary: 'Summarise the event for an internal heads-up.',
    instructions:
      'You write internal heads-up notes. Summarise what happened from the event in plain ' +
      'language, lead with why it matters, and keep it to a few lines someone can read at a ' +
      'glance. No fluff.',
    result:
      'A short internal notification: one-line headline, two or three bullets of context, ' +
      'and a suggested owner or next action.',
  },
]

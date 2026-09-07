// How long the "Signing you in as X… Not you? Sign out" state stays on screen
// before the automatic forward actually fires, for someone who lands on
// /login/ already holding a live session (#1942). Before this existed the
// redirect fired on the same render pass that showed the text, so "Not you?
// Sign out" was never on screen long enough to have a real chance of being
// clicked, and the text never said *whose* session was being resumed. Long
// enough to read and act on, short enough that an ordinary bookmark-triggered
// forward does not feel broken. Exported so tests can assert against this
// value rather than a number that could silently drift from it.
//
// Kept out of page.tsx (rather than exported from it) because the App Router
// only allows a fixed set of named exports from a page.tsx — default,
// metadata, generateMetadata, viewport, etc — and validates every other named
// export against that list at build time. An arbitrary const export like this
// one fails that validation with "does not match the required types of a
// Next.js Page", invisible locally because scripts/verify.sh's push gate
// excludes the full app build for being too slow, and only surfaced by CI.
export const FORWARD_DELAY_MS = 1500

// Single-flight registry for session API routes (ruling 4A).
// Keyed by sid; value is `true` while a start or approve request is in flight.
// A duplicate concurrent request for the same sid → 409.
// Both /api/session/start and /api/session/[id]/approve import from here so
// they genuinely share one Map — they cannot accidentally shadow each other.
export const inFlight = new Map<string, true>();

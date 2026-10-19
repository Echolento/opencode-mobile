// The plugin's GET /afk/state reply → a shape the UI can trust.
//
// Same posture as parsePushData: the value arrives over the wire from a server
// that may be older, absent, or unreachable, so nothing about it is assumed.
// Anything unexpected reads as "not armed" — the quiet default, since armed
// means notifications keep arriving.
export type AfkSnapshot = { armed: boolean; armedAt: string | null }

export function parseAfkState(body: unknown): AfkSnapshot {
  const source = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  const armedAt = typeof source.armedAt === "string" && source.armedAt ? source.armedAt : null
  return { armed: source.armed === true, armedAt }
}

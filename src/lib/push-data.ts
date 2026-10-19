export type PushCategory = "questions" | "permissions" | "completed" | "unknown"

export type PushData = {
  category: PushCategory
  title: string
  body: string
  sessionId: string | null
  permissionId: string | null
}

const CATEGORIES: PushCategory[] = ["questions", "permissions", "completed"]

const text = (value: unknown) => (typeof value === "string" && value ? value : null)

/** Normalise the FCM `data` payload from the opencode-mobile-push plugin into
 *  something a notification handler can act on. Anything unrecognised is
 *  reported as "unknown" with no deep-link target, so a malformed push can
 *  never navigate somewhere arbitrary or offer an inline reply. */
export function parsePushData(input: unknown): PushData {
  const data = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const category = CATEGORIES.includes(data.category as PushCategory) ? (data.category as PushCategory) : "unknown"
  return {
    category,
    title: text(data.title) ?? "",
    body: text(data.body) ?? "",
    sessionId: text(data.sessionId),
    permissionId: category === "permissions" ? text(data.permissionId) : null,
  }
}

export type TapData = { sessionId: string | null; permissionId: string | null }

/** What a notification tap should act on, or null to ignore it entirely.
 *
 *  Null matters: it is the difference between "open the session this is about"
 *  and "navigate somewhere on a guess" — a push that arrives without a session
 *  (malformed, or from a newer/older plugin) must not move the user anywhere.
 *  A connection notice is the one notification with nowhere to go: it is about
 *  the server, not a session, so it means "go home" rather than "ignore". */
export function tapData(input: unknown): TapData | null {
  const data = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const push = parsePushData(data)
  // Read the raw field too: the app's own notifications use categories the
  // plugin never sends (errors), and those still belong to a session.
  const sessionId = push.sessionId ?? text(data.sessionId)
  if (!sessionId && data.category !== "connection") return null
  return { sessionId, permissionId: push.permissionId }
}

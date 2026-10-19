export type PushCategory = "questions" | "permissions" | "completed" | "unknown"

export type PushData = {
  category: PushCategory
  title: string
  body: string
  sessionId: string | null
  permissionId: string | null
}

const CATEGORIES: PushCategory[] = ["questions", "permissions", "completed"]

/** Normalise the FCM `data` payload from the opencode-mobile-push plugin into
 *  something a notification handler can act on. Anything unrecognised is
 *  reported as "unknown" with no deep-link target, so a malformed push can
 *  never navigate somewhere arbitrary or offer an inline reply. */
export function parsePushData(input: unknown): PushData {
  const data = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const category = CATEGORIES.includes(data.category as PushCategory) ? (data.category as PushCategory) : "unknown"
  const text = (value: unknown) => (typeof value === "string" && value ? value : null)
  return {
    category,
    title: text(data.title) ?? "",
    body: text(data.body) ?? "",
    sessionId: text(data.sessionId),
    permissionId: category === "permissions" ? text(data.permissionId) : null,
  }
}

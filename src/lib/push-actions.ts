// Turning a notification interaction into a decision the server can act on.
//
// Kept separate from the background task itself so it can be tested without a
// device: the task's job is I/O (build a notification, POST a reply), and the
// judgement about *what* a tap means lives here.

/** The two answers a lock screen can offer. "always" is deliberately absent:
 *  granting every future request is not a decision to make with a thumb while
 *  the exact command is not in front of you. */
export const ACTION_APPROVE = "approve"
export const ACTION_REJECT = "reject"

export type PermissionReply = "once" | "always" | "reject"

/** What an action means, or null when it is not an answer (the plain tap on the
 *  notification body, an action from an older build, a future category). */
export function replyForAction(actionIdentifier: string | null | undefined): PermissionReply | null {
  if (actionIdentifier === ACTION_APPROVE) return "once"
  if (actionIdentifier === ACTION_REJECT) return "reject"
  return null
}

/** Only a permission can be answered from a notification: it is the one event
 *  that blocks the agent until a human decides. */
export function isActionable(data: Record<string, string>): boolean {
  return data.category === "permissions" && typeof data.permissionId === "string" && data.permissionId.length > 0
}

/** FCM hands the payload over nested differently depending on transport, and
 *  differently again when the launch was an action rather than an arrival. Find
 *  the notification data by the field the server always sends instead of
 *  trusting any one shape — a miss here is a silently dropped notification. */
export function extractPushData(raw: unknown): Record<string, string> | null {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): Record<string, string> | null => {
    if (depth > 5 || typeof node !== "object" || node === null) return null
    if (seen.has(node)) return null
    seen.add(node)
    const record = node as Record<string, unknown>
    if (typeof record.category === "string") {
      const data: Record<string, string> = {}
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string") data[key] = value
      }
      return data
    }
    for (const value of Object.values(record)) {
      const found = walk(value, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(raw, 0)
}

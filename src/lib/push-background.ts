import * as Notifications from "expo-notifications"
import * as TaskManager from "expo-task-manager"
import { buildAuth } from "./auth"
import { buildRequestHeaders } from "./headers"
import { log } from "./logbuffer"
import { pluginUrlFromBase } from "./plugin-url"
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  extractPushData,
  isActionable,
  replyForAction,
  type PermissionReply,
} from "./push-actions"
import { getPushTarget, type PushTarget } from "./push-target"

// Handling a notification while the app is not running.
//
// A server-rendered notification can only be tapped; Approve/Reject buttons
// have to be attached by the app. So a permission arrives data-only, the app
// builds the notification here, and the answer is posted straight back to the
// server — no app UI, no navigation, nothing to find.

const TASK = "opencode-push"
export const PERMISSION_CATEGORY = "permission"
const REQUEST_TIMEOUT_MS = 10_000

async function post(target: PushTarget, url: string, body: unknown): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const auth = buildAuth(target.username, target.password)
    const headers = buildRequestHeaders({ auth, directory: target.directory ?? undefined })
    const res = await fetch(url, {
      method: "POST",
      headers: { ...(headers as Record<string, string>), "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    return res.ok
  } catch (e) {
    log.info("push", `background request failed: ${String(e)}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Confirm the notification reached the phone. The server holds the
 *  system-rendered fallback until this arrives, so a failure here costs a
 *  duplicate notification, never a missed one. */
async function ack(pushId: string | undefined): Promise<void> {
  if (!pushId) return
  const target = await getPushTarget()
  if (!target) return
  const url = pluginUrlFromBase(target.url, "/push/ack")
  if (!url) return
  await post(target, url, { pushId })
}

async function show(data: Record<string, string>): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: data.title ?? "OpenCode",
      body: data.body ?? "",
      data,
      ...(isActionable(data) ? { categoryIdentifier: PERMISSION_CATEGORY } : {}),
    },
    trigger: null,
  })
}

async function handleAction(actionIdentifier: string, data: Record<string, string>): Promise<void> {
  const reply = replyForAction(actionIdentifier) as PermissionReply | null
  if (!reply || !data.permissionId) return
  const target = await getPushTarget()
  if (!target) return
  const base = target.url.replace(/\/+$/, "")
  const ok = await post(target, `${base}/permission/${encodeURIComponent(data.permissionId)}/reply`, { reply })
  log.info("push", `permission ${data.permissionId} answered "${reply}" from notification: ${ok}`)
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
  try {
    if (error) return
    const push = extractPushData(data)
    if (!push) return
    const raw = data as { actionIdentifier?: unknown }
    const actionIdentifier = typeof raw.actionIdentifier === "string" ? raw.actionIdentifier : null

    if (actionIdentifier) {
      // A tap on the body is not an answer; the app UI opens the session for
      // that. Only the buttons carry a decision.
      if (actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) await handleAction(actionIdentifier, push)
      return
    }

    await show(push)
    await ack(push.pushId)
  } catch (e) {
    log.info("push", `background task failed: ${String(e)}`)
  }
})

export function registerPushBackground(): void {
  try {
    void Notifications.registerTaskAsync(TASK).catch(() => undefined)
  } catch {}
  try {
    void Notifications.setNotificationCategoryAsync(PERMISSION_CATEGORY, [
      { identifier: ACTION_APPROVE, buttonTitle: "Approve once", options: { opensAppToForeground: false } },
      { identifier: ACTION_REJECT, buttonTitle: "Reject", options: { opensAppToForeground: false, isDestructive: true } },
    ]).catch(() => undefined)
  } catch {}
}

// Registered on import rather than from a component: a push that lands while
// the app is killed launches the JS without rendering any screen, and anything
// wired up by a screen would not exist yet.
registerPushBackground()

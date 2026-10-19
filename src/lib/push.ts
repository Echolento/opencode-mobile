import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"
import { useConnections } from "../stores/connections"
import { buildAuth } from "./auth"
import { buildRequestHeaders } from "./headers"
import { getDeviceToken } from "./notifications"
import { log } from "./logbuffer"
import { pluginUrlFromBase } from "./plugin-url"
import { parseAfkState, type AfkSnapshot } from "./afk-state"

// Push + AFK handoff to the self-hosted opencode server.
//
// The app cannot receive push notifications unless the server knows its FCM
// token, and the server only pings at all while the user is AFK-armed. Both are
// small authenticated calls to the `opencode-mobile-push` plugin on the same
// host as the server; endpoint/auth mirror the main client (HTTP Basic, same
// password), so no new credentials are introduced.

const PASSWORDS_PREFIX = "opencode_password_"

// The plugin's endpoints only come up once a session exists on the server (it
// instantiates lazily per project context), so the first attempt right after
// connect can race it. Retry with a widening gap before giving up.
const RETRY_DELAYS_MS = [0, 3_000, 6_000, 12_000, 20_000]
const REQUEST_TIMEOUT_MS = 10_000

async function pluginRequest(path: string, init: RequestInit): Promise<Response | null> {
  try {
    const { activeConnection: active } = useConnections.getState()
    if (!active) return null

    const url = pluginUrlFromBase(active.url, path)
    if (!url) return null

    const password = active.id ? await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`) : null
    const auth = buildAuth(active.username, password)
    const headers = buildRequestHeaders({ auth, directory: active.directory })

    // AbortSignal.timeout() is not available in the RN/Hermes runtime — use a
    // manual controller so a hung server can't leak the request forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, headers: { ...(headers as Record<string, string>), ...init.headers }, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    // Server without the push plugin (404/ECONNREFUSED) is expected and benign.
    log.info("push", `plugin request skipped: ${String(e)}`)
    return null
  }
}

const postToPlugin = (path: string, body: unknown) =>
  pluginRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

let lastSentToken: string | null = null

/** Register this device's FCM token with the active server. Best-effort and
 *  idempotent: a no-op if there is no token, no active connection, or the same
 *  token was already accepted this session. Returns true once the server
 *  acknowledges the token. */
export async function handoffPushToken(force = false): Promise<boolean> {
  let token: string | null = null
  try {
    token = await getDeviceToken()
  } catch (e) {
    log.info("push", `no device token: ${String(e)}`)
    return false
  }
  if (!token) return false
  if (!force && token === lastSentToken) return true

  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const res = await postToPlugin("/push/register", { token, platform: Platform.OS })
    if (res?.ok) {
      lastSentToken = token
      log.info("push", "device token registered with server")
      return true
    }
    if (res) log.warn("push", `token handoff failed: ${res.status}`)
  }
  log.info("push", "token handoff gave up after retries")
  return false
}

let armInFlight: Promise<boolean> | null = null

/** Tell the server the user is away, so it starts sending pings to this phone.
 *  Called whenever a prompt is sent from the phone; retried like the token
 *  handoff because the plugin endpoint races the first session. Concurrent
 *  calls share one attempt so a burst of prompts can't pile up retry loops. */
export function armAfk(): Promise<boolean> {
  if (!armInFlight) {
    armInFlight = (async () => {
      for (const delay of RETRY_DELAYS_MS) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        const res = await postToPlugin("/afk/arm", {})
        if (res?.ok) {
          log.info("push", "afk armed")
          return true
        }
      }
      return false
    })().finally(() => {
      armInFlight = null
    })
  }
  return armInFlight
}

/** Tell the server the user is back, so pings stop. */
export async function disarmAfk(): Promise<boolean> {
  const res = await postToPlugin("/afk/disarm", {})
  return res?.ok ?? false
}

/** Whether the server currently considers this user AFK-armed. Null means the
 *  server could not be asked (no connection, plugin absent, bad reply) — which
 *  is not the same as "not armed". */
export async function fetchAfkState(): Promise<AfkSnapshot | null> {
  const res = await pluginRequest("/afk/state", { method: "GET" })
  if (!res?.ok) return null
  try {
    return parseAfkState(await res.json())
  } catch {
    return null
  }
}

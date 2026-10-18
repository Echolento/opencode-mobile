import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"
import { useConnections } from "../stores/connections"
import { buildAuth } from "./auth"
import { buildRequestHeaders } from "./headers"
import { getDeviceToken } from "./notifications"
import { log } from "./logbuffer"

// Push-token handoff to the self-hosted opencode server.
//
// The app cannot receive push notifications unless the server knows its FCM
// token. On connect (and whenever the token changes) we POST the token to a
// small registration endpoint served by the `opencode-mobile-push` plugin,
// which then sends FCM on permission.asked / question / session.idle even when
// this app is killed. Endpoint/auth mirror the main client (HTTP Basic, same
// password), so no new credentials are introduced.

// The plugin listens on this port on the same host as the opencode server.
const PUSH_PORT = 4097
const PASSWORDS_PREFIX = "opencode_password_"

// The plugin's endpoint only comes up once a session exists on the server (it
// instantiates lazily per project context), so the first attempt right after
// connect can race it. Retry with a widening gap before giving up.
const RETRY_DELAYS_MS = [0, 3_000, 6_000, 12_000, 20_000]

/** Derive the push-registration URL from the server base URL, swapping the
 *  port for the plugin's port (keeps scheme + host). */
export function pushUrlFromBase(baseUrl: string, port = PUSH_PORT): string | null {
  try {
    const u = new URL(baseUrl)
    u.port = String(port)
    u.pathname = "/push/register"
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return null
  }
}

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
    if (await attemptHandoff(token)) return true
  }
  log.info("push", "token handoff gave up after retries")
  return false
}

async function attemptHandoff(token: string): Promise<boolean> {
  try {
    const { activeConnection: active } = useConnections.getState()
    if (!active) return false

    const url = pushUrlFromBase(active.url)
    if (!url) return false

    const password = active.id ? await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`) : null
    const auth = buildAuth(active.username, password)
    const headers = buildRequestHeaders({ auth, directory: active.directory })

    // AbortSignal.timeout() is not available in the RN/Hermes runtime — use a
    // manual controller so a hung server can't leak the request forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...(headers as Record<string, string>), "Content-Type": "application/json" },
        body: JSON.stringify({ token, platform: Platform.OS }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      log.warn("push", `token handoff failed: ${res.status}`)
      return false
    }
    lastSentToken = token
    log.info("push", "device token registered with server")
    return true
  } catch (e) {
    // Server without the push plugin (404/ECONNREFUSED) is expected and benign.
    log.info("push", `token handoff skipped: ${String(e)}`)
    return false
  }
}

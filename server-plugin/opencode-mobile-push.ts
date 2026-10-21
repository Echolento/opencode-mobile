import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { createAckWaiter, createAfkStore, createPusher, createPushServer, createTokenStore, readJson, sentenceDigest, trim } from "./lib"
import type { PushContent, SendPush } from "./lib"

// opencode-mobile-push — server-side half of reliable push for OpenCode Mobile.
//
// Why: the app cannot be relied on to hold a background SSE socket (Android
// suspends it), so it never gets a chance to schedule its local notifications.
// Instead the app hands its FCM token to this plugin, and the plugin pushes
// from the server on the events that matter — with the app cold/killed.
//
// Pings fire ONLY while /afk is armed (shared afk/state.json). The phone arms it
// by texting (POST /afk/arm); /back on the laptop, or POST /afk/disarm from the
// phone, silences it again.
//
// Config: ~/.config/opencode/mobile-push.json
//   {
//     "project": "your-firebase-project-id",
//     "keyFile": "~/.config/opencode/mobile-push-key.json",
//     "port": 4097
//   }
// Env overrides: OPENCODE_PUSH_PROJECT, OPENCODE_PUSH_KEY_FILE, OPENCODE_PUSH_PORT.
// OPENCODE_PUSH_HOST (e.g. the tailnet IP) is REQUIRED — the endpoint only
// starts in the process given it, so the supervisor's `serve` binds and other
// opencode processes stay silent. It is also the interface to bind.
//
// Endpoints (all HTTP Basic: <username>:<server password>):
//   POST /push/register  { "token", "platform" }   register a device
//   POST /afk/arm                                  user is away: start pinging
//   POST /afk/disarm                               user is back: stop pinging
//   GET  /afk/state                                { armed, armedAt }

const CONFIG_FILE =
  process.env.OPENCODE_PUSH_CONFIG_FILE ?? path.join(os.homedir(), ".config", "opencode", "mobile-push.json")
const TOKENS_FILE =
  process.env.OPENCODE_PUSH_TOKENS_FILE ?? path.join(os.homedir(), ".config", "opencode", "mobile-push-tokens.json")
// Shared with the /afk and /back commands.
const AFK_STATE_FILE =
  process.env.OPENCODE_AFK_STATE_FILE ?? path.join(os.homedir(), ".config", "opencode", "afk", "state.json")

// Plugin init happens inside opencode, where plugin logging is easy to lose, so
// a silently failing plugin looks identical to a plugin that was never loaded.
// OPENCODE_PUSH_DEBUG=1 appends a trace to this file instead.
const DEBUG_FILE = process.env.OPENCODE_PUSH_DEBUG_FILE ?? path.join(os.tmpdir(), "opencode-mobile-push.log")
const debug = (message: string) => {
  if (!process.env.OPENCODE_PUSH_DEBUG) return
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}
debug(`module loaded (pid ${process.pid})`)

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const WORK_TOOLS = new Set(["write", "edit", "bash", "apply_patch"])
const DONE_SUMMARY_CHARS = 200
// How long the app gets to confirm it displayed a data-only permission ping
// before the same content is re-sent as a system-rendered notification. Long
// enough for a dozing phone to wake and reach the server, short enough that the
// user is not left waiting when it cannot.
const ACK_TIMEOUT_MS = 8_000

// opencode raises `permission.asked` for requests it then auto-allows, so the
// event alone says nothing about whether a human is needed. Give the request a
// moment to be cancelled by a rule, then ask the server what is still waiting.
const PERMISSION_CONFIRM_MS = 1_500

// How often the pending list is re-read while the phone is armed. Cheap (one
// request to the local server) and it is what makes a missed event harmless.
const PERMISSION_POLL_MS = 5_000

// Ported from the Skye relay: a ping that nobody can hang on forever is not a
// prompt. A permission still pending after this long is rejected so the agent
// moves on instead of waiting for a phone that is not coming back.
const PERMISSION_TIMEOUT_MS = 10 * 60_000
const PERMISSION_POLL_MS_WHILE_WAITING = 1_500

// Skye trimmed ping bodies hard so they read on a lock screen.
const PING_BODY_CHARS = 350

type Config = { project: string; keyFile: string; port: number }

const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p)

function loadConfig(): Config | null {
  let project = process.env.OPENCODE_PUSH_PROJECT ?? ""
  let keyFile = process.env.OPENCODE_PUSH_KEY_FILE ?? ""
  let port = Number(process.env.OPENCODE_PUSH_PORT ?? 4097)
  const c = readJson<{ project?: string; keyFile?: string; port?: number }>(CONFIG_FILE)
  if (c) {
    project = c.project ?? project
    keyFile = c.keyFile ? expand(c.keyFile) : keyFile
    port = Number(c.port ?? port)
  }
  if (!project || !keyFile) return null
  return { project, keyFile, port }
}

let cachedToken: { token: string; exp: number } | null = null

async function accessToken(keyFile: string): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token
  const key = readJson<{ private_key_id: string; client_email: string; private_key: string }>(keyFile)
  if (!key) throw new Error(`service account key unreadable: ${keyFile}`)
  const now = Math.floor(Date.now() / 1000)
  const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url")
  const header = b64(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })))
  const payload = b64(
    Buffer.from(JSON.stringify({ iss: key.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })),
  )
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  const jwt = `${header}.${payload}.${b64(signer.sign(key.private_key))}`

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  })
  if (!res.ok) throw new Error(`token exchange ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 }
  return cachedToken.token
}

// FCM delivery: data-only keys mirror the app's notification contract
// (category/sessionId/permissionId) so a tap deep-links and a permission can be
// answered inline.
function makeSender(cfg: Config, log: (level: "info" | "warn", message: string) => void): SendPush {
  return async (token, message) => {
    try {
      const at = await accessToken(cfg.keyFile)
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.project}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            // Omitted for data-only messages: FCM then hands the payload to the
            // app instead of rendering it, which is what allows actions.
            ...(message.notification ? { notification: message.notification } : {}),
            data: message.data,
            android: {
              priority: "high",
              ...(message.notification ? { notification: { channel_id: "prompts" } } : {}),
            },
          },
        }),
      })
      if (!res.ok) {
        log("warn", `FCM send failed: ${res.status}`)
        return false
      }
      return true
    } catch (e) {
      log("warn", `FCM send error: ${String(e)}`)
      return false
    }
  }
}

function authorized(req: http.IncomingMessage): boolean {
  const pw = process.env.OPENCODE_SERVER_PASSWORD
  if (!pw) return true // server has no password; don't add one here
  const header = req.headers["authorization"]
  if (!header?.startsWith("Basic ")) return false
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
    return decoded.slice(decoded.indexOf(":") + 1) === pw
  } catch {
    return false
  }
}

const didWork = new Set<string>()
let listenerStarted = false

export const OpenCodeMobilePushPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  // Never let a logging failure take down plugin init: a throwing client call
  // here would abort loading the whole plugin (and with it the push endpoint).
  const log = (level: "info" | "warn", message: string) => {
    try {
      void Promise.resolve(
        client.app?.log({ body: { service: "opencode-mobile-push", level, message } }),
      ).catch(() => {})
    } catch {}
  }
  const auth = { user: process.env.OPENCODE_SERVER_USERNAME || "opencode", password: process.env.OPENCODE_SERVER_PASSWORD }
  const project = (() => {
    try {
      return path.basename(directory || process.cwd())
    } catch {
      return ""
    }
  })()

  const cfg = loadConfig()
  debug(`factory start host=${process.env.OPENCODE_PUSH_HOST ?? "<unset>"} config=${cfg ? "ok" : "missing"}`)
  if (!cfg) {
    log("warn", "no mobile-push.json (project/keyFile) — push disabled")
    return {}
  }

  const afk = createAfkStore({ file: AFK_STATE_FILE })
  const tokens = createTokenStore({ file: TOKENS_FILE })
  const send = makeSender(cfg, log)
  const acks = createAckWaiter({ timeoutMs: ACK_TIMEOUT_MS })
  const pusher = createPusher({
    store: afk,
    tokens: () => tokens.list().map((entry) => entry.token),
    send,
    acks,
  })
  const push = (content: PushContent) => pusher.push(content)

  // Only the supervised `serve` process may expose the endpoint. Every opencode
  // process loads user plugins into the same global dir, and whichever process
  // binds first would win the port with that process's credentials (starving
  // `serve` with EADDRINUSE). The supervisor marks the serve process with
  // OPENCODE_PUSH_HOST, which also selects the interface to bind. Plugins
  // instantiate lazily per project context, so this appears once a client (the
  // phone) has connected and opened a session.
  const bindHost = process.env.OPENCODE_PUSH_HOST
  if (!bindHost) {
    log("info", "OPENCODE_PUSH_HOST not set — push endpoint disabled in this process")
    return {}
  }
  if (!listenerStarted) {
    listenerStarted = true
    // Backstop for the event nudge: keeps the phone honest even if the stream
    // drops a permission (or the process never saw the session that raised it).
    setInterval(() => void announcePermissions(), PERMISSION_POLL_MS).unref()
    const server = createPushServer({
      store: afk,
      tokens,
      authorized,
      // Never the body: a registration body *is* a device credential.
      onRequest: ({ method, url, authorized: ok }) =>
        debug(`request ${method} ${url} auth=${ok ? "ok" : "REJECTED"}`),
      onAck: (pushId) => {
        const matched = acks.ack(pushId)
        debug(`ack ${pushId} matched=${matched}`)
        return matched
      },
      // Delivery is the one link the app cannot verify for itself: it only sees
      // that it handed a token over. This sends one real notification so the
      // phone, not just the server, can confirm the chain end to end.
      sendTest: async (options) => {
        const deviceTokens = tokens.list().map((entry) => entry.token)
        if (!deviceTokens.length) return { ok: false, sent: 0, error: "no device registered" }
        if (options?.permissionId) {
          if (!afk.isArmed()) return { ok: false, sent: 0, error: "AFK is not armed" }
          await pusher.push({
            category: "permissions",
            title: "Permission needed · test",
            // Unique per call: repeats are deduped by content, and a test the
            // user has to wait 20s to repeat is a test nobody repeats.
            body: `This is a test. Approve or Reject right here. (${new Date().toLocaleTimeString()})`,
            permissionId: options.permissionId,
            sessionId: options.sessionId,
          })
          return { ok: true, sent: deviceTokens.length }
        }
        const body = "Push is working. This notification came from your OpenCode server."
        let sent = 0
        for (const token of deviceTokens) {
          const ok = await send(token, {
            token,
            notification: { title: "OpenCode test", body },
            data: { category: "test", title: "OpenCode test", body },
            android: { priority: "high" },
          })
          if (ok) sent++
        }
        if (!sent) return { ok: false, sent, error: "FCM rejected every token (expired or wrong project)" }
        return { ok: true, sent }
      },
    })
    server.on("error", (e) => {
      log("warn", `push endpoint error: ${String(e)}`)
      debug(`listen error: ${String(e)}`)
    })
    debug(`listening on ${bindHost}:${cfg.port}`)
    server.listen(cfg.port, bindHost, () => {
      log("info", `push endpoint on http://${bindHost}:${cfg.port} (register, afk/arm, afk/disarm, afk/state)`)
      debug(`bound on ${bindHost}:${cfg.port}`)
    })
  }

  // The agent's closing message makes the Done ping worth reading from a lock
  // screen; the digest keeps it to complete thoughts.
  const lastAssistantText = async (sessionID: string): Promise<string> => {
    if (!auth.password || !serverUrl) return ""
    try {
      const res = await fetch(
        new URL(`/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`, serverUrl),
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (!res.ok) return ""
      const msgs = (await res.json()) as { info?: { role?: string }; parts?: { type?: string; text?: string }[] }[]
      if (!Array.isArray(msgs)) return ""
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m?.info?.role !== "assistant") continue
        const text = (m.parts ?? [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join(" ")
          .trim()
        if (text) return text
      }
    } catch {}
    return ""
  }

  // A permission ping is only useful if the agent is actually stuck. Anything
  // else (allowed by a rule, or already answered from the laptop) must go quiet.
  const pendingPermissions = async (): Promise<Record<string, unknown>[] | null> => {
    if (!auth.password || !serverUrl) return null
    // Skye polled both shapes: the bare list and the directory-scoped one.
    // Questions only ever appear scoped; permissions have been seen in either.
    const paths = [`/permission?directory=${encodeURIComponent(directory)}`, "/permission"]
    try {
      const lists = await Promise.all(
        paths.map(async (pathname) => {
          const res = await fetch(new URL(pathname, serverUrl), {
            headers: {
              Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`,
            },
            signal: AbortSignal.timeout(5_000),
          })
          if (!res.ok) return null
          const list = (await res.json()) as unknown
          return Array.isArray(list) ? (list as Record<string, unknown>[]) : null
        }),
      )
      if (lists.every((list) => list === null)) return null
      const merged = new Map<string, Record<string, unknown>>()
      for (const list of lists) for (const entry of list ?? []) merged.set(String(entry?.id ?? ""), entry)
      return [...merged.values()]
    } catch {
      return null
    }
  }

  const replyToPermission = async (id: string, reply: string) => {
    if (!auth.password || !serverUrl) return
    try {
      await fetch(new URL(`/permission/${encodeURIComponent(id)}/reply`, serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`,
        },
        body: JSON.stringify({ reply }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {}
  }

  // Skye's waiters are the reason its pings felt dependable: while a prompt was
  // outstanding something on the server was watching it, so a permission could
  // not outlive the phone's attention. Two outcomes matter here — the request
  // goes away (answered on the laptop, nothing to do) or it is still there when
  // the deadline passes (reject, so the agent is not parked forever).
  const watching = new Set<string>()

  const watchPermission = (id: string) => {
    if (watching.has(id)) return
    watching.add(id)
    const deadline = Date.now() + PERMISSION_TIMEOUT_MS
    void (async () => {
      try {
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, PERMISSION_POLL_MS_WHILE_WAITING))
          const pending = await pendingPermissions()
          if (!pending) continue
          if (!pending.some((entry) => String(entry?.id ?? "") === id)) return
        }
        await replyToPermission(id, "reject")
        log("info", `permission ${id} timed out — rejected so the agent moves on`)
      } finally {
        watching.delete(id)
      }
    })()
  }

  // Events are hints; the pending list is the truth. opencode raises
  // permission.asked for requests it then auto-allows, so pinging on the event
  // alone shouts about work that already ran — the old Skye relay learned the
  // same thing and polled the list instead of trusting the stream. Polling also
  // catches whatever the event hook misses, and an id is only ever announced
  // once, however many times it appears.
  const announcedPermissions = new Set<string>()
  const ANNOUNCED_MEMORY = 200
  let lastPendingCount: number | null = null

  const announcePermissions = async () => {
    if (!afk.isArmed()) return
    // Skye never started a waiter it could not deliver to, and it never marked a
    // ping as sent when no phone had received it. Without this an id would be
    // burned while the app is not yet registered, and the prompt would never be
    // announced again.
    if (!tokens.list().length) return
    const pending = await pendingPermissions()
    if (!pending) return
    // Edge-triggered, so the trace stays readable while proving the watcher is
    // alive (a silent poller is indistinguishable from a working one otherwise).
    if (pending.length !== lastPendingCount) {
      lastPendingCount = pending.length
      debug(`pending permissions: ${pending.length}`)
    }
    for (const entry of pending) {
      const id = String(entry.id ?? "")
      if (!id || announcedPermissions.has(id)) continue
      announcedPermissions.add(id)
      if (announcedPermissions.size > ANNOUNCED_MEMORY) {
        const oldest = announcedPermissions.values().next().value
        if (oldest) announcedPermissions.delete(oldest)
      }
      const label = String(entry.permission ?? entry.action ?? "permission")
      const patterns = Array.isArray(entry.patterns)
        ? entry.patterns
        : Array.isArray(entry.resources)
          ? entry.resources
          : []
      const detail = patterns.map(String).join(", ")
      const sessionID = String(entry.sessionID ?? "")
      await push({
        category: "permissions",
        title: `🔐 Permission · ${project}`,
        body: trim([label, detail].filter(Boolean).join(": ") || label, PING_BODY_CHARS),
        ...(sessionID ? { sessionId: sessionID } : {}),
        permissionId: id,
      })
      // Something is now watching the prompt: it either goes away (answered
      // elsewhere) or gets rejected at the deadline.
      watchPermission(id)
    }
  }

  // Let a rule finish deciding before asking the list, so an auto-allowed
  // request is never announced in the window between event and cancellation.
  const announcePermissionsSoon = () => {
    setTimeout(() => void announcePermissions(), PERMISSION_CONFIRM_MS)
  }

  return {
    "tool.execute.after": async (input) => {
      if (WORK_TOOLS.has(String(input?.tool))) didWork.add(String(input?.sessionID))
    },

    "tool.execute.before": async (input, output) => {
      try {
        if (input?.tool !== "question") return
        const questions = (output?.args as { questions?: Array<{ question?: string }> } | undefined)?.questions
        if (!Array.isArray(questions) || questions.length === 0) return
        // Skye numbered multi-question pings so the lock screen shows that a
        // choice is expected, not a wall of text.
        const asked = questions.map((q) => String(q?.question ?? "")).filter(Boolean)
        const body = asked
          .map((question, index) => (asked.length > 1 ? `Q${index + 1}: ${question}` : question))
          .join(" ")
        await push({
          category: "questions",
          title: `❓ Question · ${project}`,
          body: trim(body, PING_BODY_CHARS) || "The agent needs your input",
          sessionId: input.sessionID,
        })
      } catch (e) {
        log("warn", `question hook error: ${String(e)}`)
      }
    },

    event: async ({ event }) => {
      try {
        const type = String((event as { type?: string })?.type ?? "")
        const props = ((event as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>

        if (type === "permission.asked" || type === "permission.v2.asked") {
          if (!String(props.id ?? "")) return
          announcePermissionsSoon()
          return
        }

        if (type === "session.idle") {
          const sessionID = String(props.sessionID ?? "")
          if (!sessionID || !didWork.delete(sessionID)) return
          const summary = await lastAssistantText(sessionID)
          await push({
            category: "completed",
            title: `✅ Done · ${project}`,
            body: sentenceDigest(summary, { maxChars: DONE_SUMMARY_CHARS }) || "opencode finished a turn",
            sessionId: sessionID,
          })
        }
      } catch (e) {
        log("warn", `event hook error: ${String(e)}`)
      }
    },
  }
}

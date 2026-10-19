import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { createAfkStore, createPusher, createPushServer, createTokenStore, readJson, sentenceDigest } from "./lib"
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
            notification: { title: message.notification.title, body: message.notification.body },
            data: message.data,
            android: { priority: "high", notification: { channel_id: "prompts" } },
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
  const pusher = createPusher({
    store: afk,
    tokens: () => tokens.list().map((entry) => entry.token),
    send: makeSender(cfg, log),
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
    const server = createPushServer({ store: afk, tokens, authorized })
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

  return {
    "tool.execute.after": async (input) => {
      if (WORK_TOOLS.has(String(input?.tool))) didWork.add(String(input?.sessionID))
    },

    "tool.execute.before": async (input, output) => {
      try {
        if (input?.tool !== "question") return
        const questions = (output?.args as { questions?: Array<{ question?: string }> } | undefined)?.questions
        if (!Array.isArray(questions) || questions.length === 0) return
        const body = questions.map((q) => String(q?.question ?? "")).join(" | ")
        await push({
          category: "questions",
          title: `Question · ${project}`,
          body: sentenceDigest(body, { maxChars: 200 }) || "The agent needs your input",
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
          const label =
            type === "permission.v2.asked" ? String(props.action ?? "permission") : String(props.permission ?? "permission")
          const patterns = (type === "permission.v2.asked" ? props.resources : props.patterns) as unknown
          const detail = Array.isArray(patterns) ? patterns.map(String).join(", ") : ""
          const sessionId = String(props.sessionID ?? "")
          await push({
            category: "permissions",
            title: `Permission needed · ${project}`,
            body: [label, detail].filter(Boolean).join(": ") || label,
            ...(sessionId ? { sessionId } : {}),
            permissionId: String(props.id ?? ""),
          })
          return
        }

        if (type === "session.idle") {
          const sessionID = String(props.sessionID ?? "")
          if (!sessionID || !didWork.delete(sessionID)) return
          const summary = await lastAssistantText(sessionID)
          await push({
            category: "completed",
            title: `Done · ${project}`,
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

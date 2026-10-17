import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import crypto from "node:crypto"

// opencode-mobile-push — server-side half of reliable push for OpenCode Mobile.
//
// Why: the app cannot be relied on to hold a background SSE socket (Android
// suspends it), so it never gets a chance to schedule its local notifications.
// Instead the app hands its FCM token to this plugin, and the plugin pushes
// from the server on the events that matter — with the app cold/killed.
//
// It registers device tokens over a tiny authenticated HTTP endpoint on the
// same host as the opencode server, and reuses the FCM service-account key
// already present on this machine to send.
//
// Config: ~/.config/opencode/mobile-push.json
//   {
//     "project": "your-firebase-project-id",
//     "keyFile": "~/.config/your-firebase/key.json",
//     "port": 4097
//   }
// Env overrides: OPENCODE_PUSH_PROJECT, OPENCODE_PUSH_KEY_FILE, OPENCODE_PUSH_PORT
//
// Registering a token (the app does this automatically):
//   POST http://<host>:<port>/push/register   (HTTP Basic: <username>:<server password>)
//   { "token": "<fcm token>", "platform": "android" }

const CONFIG_FILE = path.join(os.homedir(), ".config", "opencode", "mobile-push.json")
const TOKENS_FILE = path.join(os.homedir(), ".config", "opencode", "mobile-push-tokens.json")
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const WORK_TOOLS = new Set(["write", "edit", "bash", "apply_patch"])
const DEDUPE_MS = 20_000

type Config = { project: string; keyFile: string; port: number }
type DeviceToken = { token: string; platform: string; added: number }

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url")
let cached: { token: string; exp: number } | null = null
const lastSent = new Map<string, number>()
const didWork = new Set<string>()

function expand(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
}

function loadConfig(): Config | null {
  let project = process.env.OPENCODE_PUSH_PROJECT ?? ""
  let keyFile = process.env.OPENCODE_PUSH_KEY_FILE ?? ""
  let port = Number(process.env.OPENCODE_PUSH_PORT ?? 4097)
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
    project = c.project ?? project
    keyFile = c.keyFile ? expand(c.keyFile) : keyFile
    port = Number(c.port ?? port)
  } catch {
    // env-only fallback
  }
  if (!project || !keyFile) return null
  return { project, keyFile, port }
}

function readTokens(): DeviceToken[] {
  try {
    const arr = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveToken(token: string, platform: string) {
  const tokens = readTokens().filter((t) => t.token !== token)
  tokens.push({ token, platform, added: Date.now() })
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens.slice(-20), null, 2))
}

async function accessToken(keyFile: string): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"))
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })))
  const payload = b64url(
    Buffer.from(
      JSON.stringify({ iss: key.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    ),
  )
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  const jwt = `${header}.${payload}.${b64url(signer.sign(key.private_key))}`
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  })
  if (!res.ok) throw new Error(`token exchange ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 }
  return cached.token
}

async function sendTo(token: string, cfg: Config, kind: string, title: string, body: string) {
  const at = await accessToken(cfg.keyFile)
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.project}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { kind, title, body },
        android: { priority: "high" },
      },
    }),
  })
  return res.ok
}

async function push(cfg: Config | null, kind: string, title: string, body: string) {
  if (!cfg) return
  const dkey = `${kind}:${body}`.slice(0, 200)
  const prev = lastSent.get(dkey) ?? 0
  if (Date.now() - prev < DEDUPE_MS) return
  lastSent.set(dkey, Date.now())
  for (const t of readTokens()) {
    try {
      await sendTo(t.token, cfg, kind, title, body)
    } catch {
      // best effort per device
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
    const pass = decoded.slice(decoded.indexOf(":") + 1)
    return pass === pw
  } catch {
    return false
  }
}

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

export const OpenCodeMobilePushPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  const log = (level: "info" | "warn", message: string) => {
    try {
      void client.app.log({ body: { service: "opencode-mobile-push", level, message } })
    } catch {
      console.log(`[opencode-mobile-push] ${level}: ${message}`)
    }
  }
  const project = (() => {
    try {
      return path.basename(directory || process.cwd())
    } catch {
      return ""
    }
  })()

  const cfg = loadConfig()
  if (!cfg) {
    log("warn", "no mobile-push.json (project/keyFile) — token endpoint disabled")
    return {}
  }

  const host = serverUrl?.hostname ?? "127.0.0.1"
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/push/register")) {
      res.writeHead(404).end()
      return
    }
    if (!authorized(req)) {
      res.writeHead(401).end()
      return
    }
    let body = ""
    req.on("data", (c) => {
      body += c
      if (body.length > 8192) req.destroy()
    })
    req.on("end", () => {
      try {
        const { token, platform } = JSON.parse(body || "{}")
        if (typeof token !== "string" || !token) {
          res.writeHead(400).end()
          return
        }
        saveToken(token, String(platform ?? "unknown"))
        log("info", `registered push token (${platform})`)
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400).end()
      }
    })
  })
  server.on("error", (e) => log("warn", `token endpoint error: ${String(e)}`))
  server.listen(cfg.port, host, () => log("info", `push token endpoint on http://${host}:${cfg.port}/push/register`))

  return {
    "tool.execute.after": async (input) => {
      if (WORK_TOOLS.has(String(input?.tool))) didWork.add(String(input?.sessionID))
    },

    "tool.execute.before": async (input, output) => {
      try {
        if (input?.tool !== "question") return
        const questions = (output?.args as { questions?: Array<{ question?: string }> })?.questions
        if (!Array.isArray(questions) || questions.length === 0) return
        const body = trim(questions.map((q) => String(q?.question ?? "")).join(" | "), 300)
        await push(cfg, "question", `Question · ${project}`, body || "The agent needs your input")
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
          const body = trim([label, detail].filter(Boolean).join(": "), 300) || label
          await push(cfg, "permission", `Permission needed · ${project}`, body)
          return
        }

        if (type === "session.idle") {
          const sessionID = String(props.sessionID ?? "")
          if (!sessionID || !didWork.delete(sessionID)) return
          await push(cfg, "done", `Done · ${project}`, "opencode finished a turn")
        }
      } catch (e) {
        log("warn", `event hook error: ${String(e)}`)
      }
    },
  }
}

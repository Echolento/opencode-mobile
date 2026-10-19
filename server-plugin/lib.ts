import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import type { IncomingMessage, Server } from "node:http"

// Server-side logic for opencode-mobile-push, split out of the plugin so it can
// be exercised without opencode: everything here touches only node builtins and
// takes its file paths / credentials as arguments.

// These files are hand-written and script-written on Windows, where
// `Set-Content -Encoding utf8` (PowerShell 5.1) and `Out-File` prepend a UTF-8
// BOM. JSON.parse rejects a BOM outright, so a stray BOM used to read as
// "not armed" / "no devices registered" — silently disabling push.
export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T
  } catch {
    return null
  }
}

export type AfkSnapshot = { armed: boolean; armedAt: string | null }

export type AfkStore = {
  snapshot: () => AfkSnapshot
  isArmed: () => boolean
  arm: (at?: Date) => void
  disarm: () => void
}

// Armed state lives in a single JSON file shared with the /afk ... /back
// commands, so the phone can arm it and the laptop can disarm it.
export function createAfkStore({ file }: { file: string }): AfkStore {
  const snapshot = (): AfkSnapshot => {
    const parsed = readJson<{ armedAt?: unknown }>(file)
    const armedAt = typeof parsed?.armedAt === "string" && parsed.armedAt ? parsed.armedAt : null
    return { armed: armedAt !== null, armedAt }
  }
  return {
    snapshot,
    isArmed: () => snapshot().armed,
    arm: (at: Date = new Date()) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ armedAt: at.toISOString() }))
    },
    disarm: () => {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
    },
  }
}

// Notification bodies must read as complete thoughts: prefer whole sentences
// up to the character budget, and if even the first sentence is too long, cut
// at a word boundary rather than mid-word.
export function sentenceDigest(text: string, { maxChars = 200 }: { maxChars?: number } = {}): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (!clean) return ""
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean)

  let out = ""
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence
    if (next.length > maxChars) break
    out = next
  }
  if (out) return out

  const first = sentences[0] ?? clean
  const head = first.slice(0, maxChars - 1)
  return `${(head.replace(/\s+\S*$/, "") || head).trimEnd()}…`
}

// Categories mirror the app's notification preferences so the payload speaks
// the same language the client already understands.
export type PushCategory = "questions" | "permissions" | "completed"

export type PushContent = {
  category: PushCategory
  title: string
  body: string
  sessionId?: string
  permissionId?: string
}

export type PushMessage = {
  token: string
  notification: { title: string; body: string }
  data: Record<string, string>
  android: { priority: "high" }
}

export type SendPush = (token: string, message: PushMessage) => Promise<boolean>

export function createPusher({
  store,
  tokens,
  send,
  now = () => Date.now(),
  dedupeMs = 20_000,
}: {
  store: AfkStore
  tokens: () => string[]
  send: SendPush
  now?: () => number
  dedupeMs?: number
}) {
  const lastSent = new Map<string, number>()
  return {
    push: async (content: PushContent) => {
      // The whole point of /afk: no notification unless the user asked to be
      // reachable from the phone.
      if (!store.isArmed()) return
      const key = `${content.category}:${content.body}`.slice(0, 200)
      if (now() - (lastSent.get(key) ?? -Infinity) < dedupeMs) return
      lastSent.set(key, now())
      const data: Record<string, string> = {
        category: content.category,
        title: content.title,
        body: content.body,
      }
      if (content.sessionId) data.sessionId = content.sessionId
      if (content.permissionId) data.permissionId = content.permissionId
      for (const token of tokens()) {
        await send(token, {
          token,
          notification: { title: content.title, body: content.body },
          data,
          android: { priority: "high" },
        })
      }
    },
  }
}

export type DeviceToken = { token: string; platform: string; added: number }

export type TokenStore = {
  list: () => DeviceToken[]
  add: (token: string, platform: string) => void
}

// Registered devices persist across restarts so the phone keeps receiving pings
// while the laptop server comes and goes. Re-registering a token refreshes it
// instead of duplicating it.
export function createTokenStore({ file, cap = 20 }: { file: string; cap?: number }): TokenStore {
  const list = (): DeviceToken[] => {
    const parsed = readJson<DeviceToken[]>(file)
    return Array.isArray(parsed) ? parsed : []
  }
  return {
    list,
    add: (token: string, platform: string) => {
      const next = list().filter((entry) => entry.token !== token)
      next.push({ token, platform, added: Date.now() })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(next.slice(-cap), null, 2))
    },
  }
}

const MAX_BODY = 8192

export function createPushServer({
  store,
  tokens,
  authorized,
}: {
  store: AfkStore
  tokens: TokenStore
  authorized: (req: IncomingMessage) => boolean
}): Server {
  return http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end()
      return
    }
    if (req.method === "POST" && req.url === "/push/register") {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
        if (body.length > MAX_BODY) req.destroy()
      })
      req.on("end", () => {
        try {
          const { token, platform } = JSON.parse(body || "{}")
          if (typeof token !== "string" || !token) {
            res.writeHead(400).end()
            return
          }
          tokens.add(token, String(platform ?? "unknown"))
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400).end()
        }
      })
      return
    }
    if (req.method === "POST" && req.url === "/afk/arm") {
      store.arm()
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === "POST" && req.url === "/afk/disarm") {
      store.disarm()
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === "GET" && req.url === "/afk/state") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(store.snapshot()))
      return
    }
    res.writeHead(404).end()
  })
}

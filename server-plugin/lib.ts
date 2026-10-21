import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
  /** Absent for a data-only message: the app is then expected to build the
   *  notification itself, which is the only way it can carry actions. */
  notification?: { title: string; body: string }
  data: Record<string, string>
  android: { priority: "high" }
}

export type SendPush = (token: string, message: PushMessage) => Promise<boolean>

// A data-only message is handed to the app, which decides whether to display
// it — and it can display it with Approve/Reject buttons. That is also the one
// delivery mode Android may withhold while the phone dozes, so the sender waits
// for the app to say "shown"; if it never does, the same content is re-sent as a
// normal notification that the system renders no matter what. Buttons when the
// app can act, guaranteed delivery when it cannot.
export type AckWaiter = {
  wait: (id: string, timeoutMs?: number) => Promise<boolean>
  ack: (id: string) => boolean
}

export function createAckWaiter({ timeoutMs = 8_000 }: { timeoutMs?: number } = {}): AckWaiter {
  const pending = new Map<string, (ok: boolean) => void>()
  return {
    wait: (id, override) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(false)
        }, override ?? timeoutMs)
        pending.set(id, (ok) => {
          clearTimeout(timer)
          resolve(ok)
        })
      }),
    ack: (id) => {
      const resolve = pending.get(id)
      if (!resolve) return false
      pending.delete(id)
      resolve(true)
      return true
    },
  }
}

export function createPusher({
  store,
  tokens,
  send,
  acks,
  newId = () => randomUUID(),
  now = () => Date.now(),
  dedupeMs = 20_000,
}: {
  store: AfkStore
  tokens: () => string[]
  send: SendPush
  acks?: AckWaiter
  newId?: () => string
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
      const devices = tokens()

      // A permission is the only thing worth answering from the notification
      // itself, and actions can only be attached by the app. Ask it to show the
      // notification (data-only), and if it never confirms, fall back to the
      // system-rendered one so the user is pinged regardless.
      if (content.category === "permissions" && acks && content.permissionId) {
        const pushId = newId()
        const shown = acks.wait(pushId)
        const withId = { ...data, pushId }
        for (const token of devices) {
          await send(token, { token, data: withId, android: { priority: "high" } })
        }
        if (await shown) return
        for (const token of devices) {
          await send(token, {
            token,
            notification: { title: content.title, body: content.body },
            data: withId,
            android: { priority: "high" },
          })
        }
        return
      }

      for (const token of devices) {
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

export type TestPushResult = { ok: boolean; sent?: number; error?: string }

/** A test push normally proves delivery. Given a permission id it instead poses
 *  a permission, which is how the Approve/Reject buttons get exercised without
 *  waiting for the agent to actually need approval. */
export type TestPushOptions = { permissionId?: string; sessionId?: string }

/** opencode emits `permission.asked` for every request it evaluates, including
 *  the ones a rule auto-allows; those are never waiting on a human, so waking
 *  someone for them is pure noise. Only an id still on the pending list is
 *  actually blocking the agent. A null list means "could not check" and is
 *  treated as pending, because a missed block is worse than a spare ping. */
export function stillPending(id: string, pending: { id?: unknown }[] | null): boolean {
  if (!id) return false
  if (pending === null) return true
  return pending.some((entry) => String(entry?.id ?? "") === id)
}

export function createPushServer({
  store,
  tokens,
  authorized,
  onRequest,
  sendTest,
  onAck,
}: {
  store: AfkStore
  tokens: TokenStore
  authorized: (req: IncomingMessage) => boolean
  onRequest?: (info: { method: string; url: string; authorized: boolean }) => void
  /** Delivers a notification regardless of AFK state: the point is to prove
   *  delivery works, and a user who armed nothing still needs to test their
   *  phone. Optional, so a server can stay send-only. */
  sendTest?: (options?: TestPushOptions) => Promise<TestPushResult>
  /** Called when the app confirms it displayed a data-only push, which is what
   *  suppresses the system-rendered fallback. */
  onAck?: (pushId: string) => void
}): Server {
  return http.createServer((req, res) => {
    const authorized_ = authorized(req)
    // Reported before the verdict is acted on: a rejected request is the
    // interesting one (the phone reached us but its credentials did not match),
    // and it is otherwise completely invisible.
    try {
      onRequest?.({ method: String(req.method ?? ""), url: String(req.url ?? ""), authorized: authorized_ })
    } catch {}
    if (!authorized_) {
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
    if (req.method === "POST" && req.url === "/push/ack") {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
        if (body.length > MAX_BODY) req.destroy()
      })
      req.on("end", () => {
        try {
          const { pushId } = JSON.parse(body || "{}")
          if (typeof pushId !== "string" || !pushId) {
            res.writeHead(400).end()
            return
          }
          const matched = onAck?.(pushId) ?? false
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ ok: true, matched }))
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
    if (req.method === "POST" && req.url === "/push/test") {
      if (!sendTest) {
        res.writeHead(404).end()
        return
      }
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
        if (body.length > MAX_BODY) req.destroy()
      })
      req.on("end", () => {
        let options: TestPushOptions = {}
        if (body.trim()) {
          try {
            options = JSON.parse(body) as TestPushOptions
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad json" }))
            return
          }
        }
        void sendTest(options)
          .then((result) => {
            res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" }).end(JSON.stringify(result))
          })
          .catch((e: unknown) => {
            res
              .writeHead(502, { "Content-Type": "application/json" })
              .end(JSON.stringify({ ok: false, error: String(e) } satisfies TestPushResult))
          })
      })
      return
    }
    res.writeHead(404).end()
  })
}

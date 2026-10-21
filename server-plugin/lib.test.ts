import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { createAfkStore, createAckWaiter, createPushServer, createPusher, createTokenStore, stillPending } from "./lib.ts"
import type { PushMessage } from "./lib.ts"

// AFK arming is the switch that decides whether the phone gets pinged at all.
// The app arms it by texting from the phone; these tests pin that behaviour
// through the server's public HTTP surface, not its internals.

const CREDENTIALS = "opencode:secret"
const AUTH = `Basic ${Buffer.from(CREDENTIALS).toString("base64")}`

const authorized = (req: IncomingMessage) => req.headers.authorization === AUTH

function tempStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "afk-state-")), "state.json")
}

async function startServer(file: string) {
  const tokens = createTokenStore({ file: `${file}.tokens.json` })
  const server = createPushServer({ store: createAfkStore({ file }), tokens, authorized })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("an unauthenticated caller cannot arm the session", async () => {
  const file = tempStateFile()
  const { base, close } = await startServer(file)
  try {
    const res = await fetch(`${base}/afk/arm`, { method: "POST" })
    assert.equal(res.status, 401)

    const state = await fetch(`${base}/afk/state`, { headers: { Authorization: AUTH } })
    assert.equal((await state.json()).armed, false)
  } finally {
    await close()
  }
})

test("disarming from the laptop silences the phone", async () => {
  const file = tempStateFile()
  const { base, close } = await startServer(file)
  try {
    await fetch(`${base}/afk/arm`, { method: "POST", headers: { Authorization: AUTH } })
    const res = await fetch(`${base}/afk/disarm`, { method: "POST", headers: { Authorization: AUTH } })
    assert.equal(res.status, 200)

    const state = await fetch(`${base}/afk/state`, { headers: { Authorization: AUTH } })
    assert.deepEqual(await state.json(), { armed: false, armedAt: null })
  } finally {
    await close()
  }
})

test("arming from the phone marks the session AFK", async () => {
  const file = tempStateFile()
  const { base, close } = await startServer(file)
  try {
    const armed = await fetch(`${base}/afk/arm`, { method: "POST", headers: { Authorization: AUTH } })
    assert.equal(armed.status, 200)

    const state = await fetch(`${base}/afk/state`, { headers: { Authorization: AUTH } })
    const body = await state.json()
    assert.equal(body.armed, true)
    assert.equal(typeof body.armedAt, "string")
  } finally {
    await close()
  }
})

test("the phone stays silent while not armed", async () => {
  const file = tempStateFile()
  const store = createAfkStore({ file })

  const sent: unknown[] = []
  const pusher = createPusher({
    store,
    tokens: () => ["device-a"],
    send: async (_token, message) => {
      sent.push(message)
      return true
    },
  })

  await pusher.push({ category: "completed", title: "Done", body: "opencode finished a turn" })

  assert.deepEqual(sent, [])
})

test("a ping reaches every registered device while AFK", async () => {
  const file = tempStateFile()
  const store = createAfkStore({ file })
  store.arm()

  const sent: { token: string; category: string }[] = []
  const pusher = createPusher({
    store,
    tokens: () => ["device-a", "device-b"],
    send: async (token, message) => {
      sent.push({ token, category: message.data.category })
      return true
    },
  })

  await pusher.push({ category: "permissions", title: "Permission needed", body: "bash: rm -rf build" })

  assert.deepEqual(sent, [
    { token: "device-a", category: "permissions" },
    { token: "device-b", category: "permissions" },
  ])
})

test("a permission ping carries the session and permission ids", async () => {
  const file = tempStateFile()
  const store = createAfkStore({ file })
  store.arm()

  const data: Record<string, string>[] = []
  const pusher = createPusher({
    store,
    tokens: () => ["device-a"],
    send: async (_token, message) => {
      data.push(message.data)
      return true
    },
  })

  await pusher.push({
    category: "permissions",
    title: "Permission needed",
    body: "bash: rm -rf build",
    sessionId: "ses_abc",
    permissionId: "per_123",
  })

  // Tapping must land on the exact session, and the inline Approve/Reject
  // buttons must know which permission they are answering.
  assert.equal(data[0].sessionId, "ses_abc")
  assert.equal(data[0].permissionId, "per_123")
})

test("the app registers its push token and the server remembers it", async () => {
  const file = tempStateFile()
  const { base, tokens, close } = await startServer(file)
  try {
    const res = await fetch(`${base}/push/register`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fcm-token-1", platform: "android" }),
    })
    assert.equal(res.status, 200)
    assert.equal(tokens.list()[0].token, "fcm-token-1")
  } finally {
    await close()
  }
})

test("a registration without a token is rejected", async () => {
  const file = tempStateFile()
  const { base, tokens, close } = await startServer(file)
  try {
    const res = await fetch(`${base}/push/register`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "android" }),
    })
    assert.equal(res.status, 400)
    assert.deepEqual(tokens.list(), [])
  } finally {
    await close()
  }
})

test("the same ping is not repeated inside the dedupe window", async () => {
  const file = tempStateFile()
  const store = createAfkStore({ file })
  store.arm()

  let clock = 1_000
  const sent: string[] = []
  const pusher = createPusher({
    store,
    tokens: () => ["device-a"],
    now: () => clock,
    send: async (_token, message) => {
      sent.push(message.data.category)
      return true
    },
  })

  const content = { category: "completed" as const, title: "Done", body: "opencode finished a turn" }
  await pusher.push(content)
  clock += 5_000
  await pusher.push(content)
  assert.deepEqual(sent, ["completed"])

  clock += 20_000
  await pusher.push(content)
  assert.deepEqual(sent, ["completed", "completed"])
})

test("arming survives a restart of the server", async () => {
  const file = tempStateFile()
  const first = await startServer(file)
  await fetch(`${first.base}/afk/arm`, { method: "POST", headers: { Authorization: AUTH } })
  await first.close()

  // A fresh process (fresh stores, same file) must still see the phone as AFK:
  // arming is intent, and it only ends on /back.
  const second = await startServer(file)
  try {
    const state = await fetch(`${second.base}/afk/state`, { headers: { Authorization: AUTH } })
    assert.equal((await state.json()).armed, true)
  } finally {
    await second.close()
  }
})

// These files are hand-edited and script-written on Windows, where
// `Set-Content -Encoding utf8` (PowerShell 5.1) and `Out-File` prepend a UTF-8
// BOM. JSON.parse rejects a BOM outright, so a stray BOM used to read as "not
// armed" / "no devices registered" — silently disabling push.
test("a BOM in the state file does not read as disarmed", () => {
  const file = tempStateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ armedAt: new Date().toISOString() })}`)

  assert.equal(createAfkStore({ file }).isArmed(), true)
})

test("a BOM in the token file does not lose registered devices", () => {
  const file = `${tempStateFile()}.tokens.json`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `\uFEFF${JSON.stringify([{ token: "device-a", platform: "android", added: 1 }])}`)

  assert.deepEqual(
    createTokenStore({ file }).list().map((entry) => entry.token),
    ["device-a"],
  )
})

// "The phone never registers" has several indistinguishable causes (app too old
// to register, notifications denied, wrong password, unreachable endpoint). The
// server can only say which one it is if it reports what actually reached it.
test("the endpoint reports every request it saw, with its auth verdict", async () => {
  const file = tempStateFile()
  const seen: Array<{ method: string; url: string; authorized: boolean }> = []
  const server = createPushServer({
    store: createAfkStore({ file }),
    tokens: createTokenStore({ file: `${file}.tokens.json` }),
    authorized,
    onRequest: (info) => seen.push(info),
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await fetch(`http://127.0.0.1:${port}/afk/state`)
    await fetch(`http://127.0.0.1:${port}/afk/state`, { headers: { Authorization: AUTH } })
    await fetch(`http://127.0.0.1:${port}/push/register`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "device-a", platform: "android" }),
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  assert.deepEqual(seen, [
    { method: "GET", url: "/afk/state", authorized: false },
    { method: "GET", url: "/afk/state", authorized: true },
    { method: "POST", url: "/push/register", authorized: true },
  ])
})

// Handing the token over only proves the app talked to the server; it says
// nothing about whether the phone can receive anything. A test push is the only
// way to find out without waiting for a real prompt.
async function startTestServer(sendTest?: () => Promise<{ ok: boolean; sent?: number; error?: string }>) {
  const file = tempStateFile()
  const tokens = createTokenStore({ file: `${file}.tokens.json` })
  const server = createPushServer({ store: createAfkStore({ file }), tokens, authorized, sendTest })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test("a test push reports how many devices it reached", async () => {
  const server = await startTestServer(async () => ({ ok: true, sent: 1 }))
  try {
    const res = await fetch(`${server.base}/push/test`, { method: "POST", headers: { Authorization: AUTH } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, sent: 1 })
  } finally {
    await server.close()
  }
})

test("a test push that delivered nothing fails loudly instead of claiming success", async () => {
  const server = await startTestServer(async () => ({ ok: false, sent: 0, error: "no device registered" }))
  try {
    const res = await fetch(`${server.base}/push/test`, { method: "POST", headers: { Authorization: AUTH } })
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { ok: false, sent: 0, error: "no device registered" })
  } finally {
    await server.close()
  }
})

test("a server without a sender has no test endpoint", async () => {
  const server = await startTestServer()
  try {
    const res = await fetch(`${server.base}/push/test`, { method: "POST", headers: { Authorization: AUTH } })
    assert.equal(res.status, 404)
  } finally {
    await server.close()
  }
})

test("an unauthenticated caller cannot make the server send a notification", async () => {
  let sent = false
  const server = await startTestServer(async () => {
    sent = true
    return { ok: true, sent: 1 }
  })
  try {
    const res = await fetch(`${server.base}/push/test`, { method: "POST" })
    assert.equal(res.status, 401)
    assert.equal(sent, false)
  } finally {
    await server.close()
  }
})

// Approve/Reject can only be attached by the app, so a permission is delivered
// data-only and the app builds the notification. Two things can go wrong: the
// app never sees it (Doze) or never shows it. Either way the user must still be
// told, so the sender waits for a confirmation and falls back to a plain push.
function pusherHarness(timeoutMs: number) {
  const file = tempStateFile()
  const store = createAfkStore({ file })
  store.arm()
  const sent: PushMessage[] = []
  const acks = createAckWaiter({ timeoutMs })
  const pusher = createPusher({
    store,
    tokens: () => ["device-a"],
    send: async (_token, message) => {
      sent.push(message)
      return true
    },
    acks,
    newId: () => "push-1",
  })
  return { sent, acks, pusher }
}

test("a permission goes out without a notification block so the app can add actions", async () => {
  const { sent, acks, pusher } = pusherHarness(500)
  const delivered = pusher.push({ category: "permissions", title: "Permission", body: "rm -rf", permissionId: "perm-1" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].notification, undefined)
  assert.equal(sent[0].data.permissionId, "perm-1")
  assert.equal(sent[0].data.pushId, "push-1")
  acks.ack("push-1")
  await delivered
  assert.equal(sent.length, 1, "a confirmation suppresses the fallback")
})

test("a permission the app never confirms still reaches the phone", async () => {
  const { sent, pusher } = pusherHarness(20)
  await pusher.push({ category: "permissions", title: "Permission", body: "rm -rf", permissionId: "perm-1" })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].notification, undefined)
  assert.deepEqual(sent[1].notification, { title: "Permission", body: "rm -rf" })
  assert.equal(sent[1].data.permissionId, "perm-1", "the fallback keeps the id so a tap can still act")
})

test("questions and completion notices are sent the reliable way from the start", async () => {
  const { sent, pusher } = pusherHarness(20)
  await pusher.push({ category: "questions", title: "Question", body: "Which file?" })
  assert.equal(sent.length, 1)
  assert.ok(sent[0].notification)
})

test("a permission without an id cannot be acted on, so it is not sent data-only", async () => {
  const { sent, pusher } = pusherHarness(20)
  await pusher.push({ category: "permissions", title: "Permission", body: "rm -rf" })
  assert.equal(sent.length, 1)
  assert.ok(sent[0].notification)
})

test("a test push can pose a permission so the buttons can be tried on demand", async () => {
  let received: { permissionId?: string; sessionId?: string } | undefined
  const server = await startTestServer(async (options) => {
    received = options
    return { ok: true, sent: 1 }
  })
  try {
    const res = await fetch(`${server.base}/push/test`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ permissionId: "perm-7", sessionId: "ses-1" }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(received, { permissionId: "perm-7", sessionId: "ses-1" })
  } finally {
    await server.close()
  }
})

test("a malformed test request is rejected instead of sending something unexpected", async () => {
  let called = false
  const server = await startTestServer(async () => {
    called = true
    return { ok: true, sent: 1 }
  })
  try {
    const res = await fetch(`${server.base}/push/test`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: "{not json",
    })
    assert.equal(res.status, 400)
    assert.equal(called, false)
  } finally {
    await server.close()
  }
})

test("a permission is only worth a ping while the server still lists it as pending", () => {
  assert.equal(stillPending("perm-1", [{ id: "perm-1" }, { id: "perm-2" }]), true)
  assert.equal(stillPending("perm-1", [{ id: "perm-2" }]), false, "an auto-allowed request is already gone")
  assert.equal(stillPending("perm-1", null), true, "uncheckable must not silence a real block")
  assert.equal(stillPending("", [{ id: "perm-1" }]), false)
})

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { createAfkStore, createPushServer, createPusher, createTokenStore } from "./lib.ts"

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

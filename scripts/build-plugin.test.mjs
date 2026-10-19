// Guards the packaging step, then boots the built plugin for real.
//
// The bug this exists for: a plugin that does `import ... from "./lib"` fails to
// load in opencode (no relative-import resolution between plugin files) and
// silently takes the push endpoint down. Unit tests on lib.ts cannot catch that,
// so this test builds the single-file bundle and starts it the way opencode
// would — then talks to its HTTP endpoint over a real socket.

import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distFile = path.join(root, "server-plugin", "dist", "opencode-mobile-push.ts")
const build = () => execFileSync(process.execPath, ["scripts/build-plugin.mjs"], { cwd: root })

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

test("the built plugin is self-contained", () => {
  build()
  const dist = fs.readFileSync(distFile, "utf8")

  assert.ok(!/from "\.\//.test(dist), "bundle must not reference sibling files")
  for (const symbol of ["createAfkStore", "createTokenStore", "createPusher", "createPushServer", "sentenceDigest"]) {
    assert.ok(dist.includes(symbol), `lib.ts symbol ${symbol} missing from bundle`)
  }
  assert.match(dist, /export const OpenCodeMobilePushPlugin/)
  // Only lib.ts is inlined, so its exports must have been flattened away.
  assert.ok(!/^export (function|const) createPushServer/m.test(dist))
})

test("the built plugin initializes and serves its endpoints", async () => {
  build()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-"))
  const configFile = path.join(dir, "mobile-push.json")
  const tokensFile = path.join(dir, "tokens.json")
  const afkFile = path.join(dir, "afk.json")
  // No `port` here on purpose: the config file wins over the env var, and the
  // test polls the port it set via OPENCODE_PUSH_PORT.
  //
  // The leading BOM is the point: this config is edited by hand and written by
  // PowerShell, whose `Set-Content -Encoding utf8` adds one. A BOM made
  // JSON.parse throw, so the plugin read itself as unconfigured and never bound
  // the endpoint — a silent, total failure of push.
  fs.writeFileSync(
    configFile,
    `\uFEFF${JSON.stringify({ project: "test-project", keyFile: path.join(dir, "key.json") })}`,
  )

  const childFile = path.join(dir, "boot.mjs")
  fs.writeFileSync(
    childFile,
    `
import fs from "node:fs"
import { pathToFileURL } from "node:url"

const mod = await import(pathToFileURL(process.argv[2]).href)
const client = { app: { log: async () => {} } }
const port = Number(process.env.OPENCODE_PUSH_PORT)
const hooks = await mod.OpenCodeMobilePushPlugin({
  client,
  directory: ${JSON.stringify(dir)},
  serverUrl: "http://127.0.0.1:1",
})

const auth = { Authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") }
const url = (p) => \`http://127.0.0.1:\${port}\${p}\`
// listen() is async; the endpoint appears a moment after the factory returns.
const get = async (p, init) => {
  for (let i = 0; i < 50; i++) {
    try { return await fetch(url(p), init) } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  throw new Error("endpoint never came up on " + port)
}

const results = {
  hasEvent: typeof hooks.event === "function",
  hasQuestionHook: typeof hooks["tool.execute.before"] === "function",
  unauthenticated: (await get("/afk/state")).status,
  initialState: await (await get("/afk/state", { headers: auth })).json(),
}
await get("/afk/arm", { method: "POST", headers: auth })
results.armedState = await (await get("/afk/state", { headers: auth })).json()
results.register = (
  await get("/push/register", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "tok-1", platform: "android" }),
  })
).status
results.tokens = JSON.parse(fs.readFileSync(process.env.OPENCODE_PUSH_TOKENS_FILE, "utf8"))
results.badRegister = (
  await get("/push/register", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" })
).status

process.stdout.write("RESULT " + JSON.stringify(results) + "\\n")
process.exit(0)
`,
  )

  const stdout = execFileSync(process.execPath, [childFile, distFile], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_PUSH_CONFIG_FILE: configFile,
      OPENCODE_PUSH_TOKENS_FILE: tokensFile,
      OPENCODE_AFK_STATE_FILE: afkFile,
      OPENCODE_PUSH_HOST: "127.0.0.1",
      OPENCODE_PUSH_PORT: String(await freePort()),
      OPENCODE_SERVER_PASSWORD: "pw",
    },
  }).toString()

  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "))
  assert.ok(line, `expected a RESULT line, got: ${stdout}`)
  const r = JSON.parse(line.slice("RESULT ".length))

  assert.equal(r.hasEvent, true)
  assert.equal(r.hasQuestionHook, true)
  assert.equal(r.unauthenticated, 401, "endpoint must require the server password")
  assert.deepEqual(r.initialState, { armed: false, armedAt: null })
  assert.equal(r.armedState.armed, true, "POST /afk/arm must arm the shared state file")
  assert.equal(r.register, 200)
  assert.deepEqual(
    r.tokens.map((t) => [t.token, t.platform]),
    [["tok-1", "android"]],
  )
  assert.equal(r.badRegister, 400, "a tokenless registration is a bad request")
})

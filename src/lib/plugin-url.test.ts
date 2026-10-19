import { test } from "node:test"
import assert from "node:assert/strict"
import { pluginUrlFromBase, PUSH_PORT } from "./plugin-url.ts"

// The opencode-mobile-push plugin listens on its own port on the same host as
// the server, so every app -> plugin call (token registration, arming) derives
// its URL by swapping the port and replacing the path.

test("swaps the server port for the plugin port and sets the path", () => {
  assert.equal(
    pluginUrlFromBase("http://100.99.67.68:4096", "/push/register"),
    `http://100.99.67.68:${PUSH_PORT}/push/register`,
  )
})

test("derives the arming URL", () => {
  assert.equal(pluginUrlFromBase("http://100.99.67.68:4096", "/afk/arm"), `http://100.99.67.68:${PUSH_PORT}/afk/arm`)
})

test("keeps the scheme of the connection", () => {
  assert.equal(pluginUrlFromBase("https://example.test:4096", "/afk/state"), `https://example.test:${PUSH_PORT}/afk/state`)
})

test("drops any query or hash from the server URL", () => {
  assert.equal(pluginUrlFromBase("http://host:4096/?directory=%2Ftmp#x", "/afk/arm"), `http://host:${PUSH_PORT}/afk/arm`)
})

test("an unusable base URL yields null instead of throwing", () => {
  assert.equal(pluginUrlFromBase("not a url", "/afk/arm"), null)
})

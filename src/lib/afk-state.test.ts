// The plugin's GET /afk/state reply decides whether the phone shows "pings on"
// and offers "stop pings". It arrives over the wire from a server that may be
// older, absent, or hand-edited, so nothing about it is assumed — and anything
// unexpected must read as *not armed*, the quiet default.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAfkState } from "./afk-state.ts"

test("an armed server reports its arming time", () => {
  const snapshot = parseAfkState({ armed: true, armedAt: "2026-10-18T18:14:02.070Z" })
  assert.deepEqual(snapshot, { armed: true, armedAt: "2026-10-18T18:14:02.070Z" })
})

test("an armed server without a timestamp still counts as armed", () => {
  assert.deepEqual(parseAfkState({ armed: true }), { armed: true, armedAt: null })
})

test("a disarmed or empty reply is not armed", () => {
  assert.deepEqual(parseAfkState({ armed: false, armedAt: null }), { armed: false, armedAt: null })
  assert.deepEqual(parseAfkState({}), { armed: false, armedAt: null })
})

test("junk replies fall back to not armed rather than throwing", () => {
  for (const body of [null, undefined, "yes", 7, [], { armed: "yes" }, { armed: 1 }]) {
    assert.deepEqual(parseAfkState(body), { armed: false, armedAt: null }, `body: ${JSON.stringify(body)}`)
  }
})

test("a non-string timestamp is dropped instead of rendered", () => {
  assert.deepEqual(parseAfkState({ armed: true, armedAt: 12345 }), { armed: true, armedAt: null })
  assert.deepEqual(parseAfkState({ armed: true, armedAt: "" }), { armed: true, armedAt: null })
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { serverOwns } from "./server-owned.ts"

// Two notification paths used to exist for the same events: the server pushed
// them, and the app scheduled them locally too. The local one fired for every
// permission.asked, including the eight an ordinary auto-allowed command emits,
// and ignored /afk entirely, so the phone shouted for work that had already run.
// Exactly one side may own a prompt.

test("prompts and completions belong to the server", () => {
  assert.equal(serverOwns("permissions"), true)
  assert.equal(serverOwns("questions"), true)
  assert.equal(serverOwns("completed"), true)
})

test("transport problems stay local, because the server cannot report them", () => {
  assert.equal(serverOwns("connection"), false)
  assert.equal(serverOwns("errors"), false)
})

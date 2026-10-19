import { test } from "node:test"
import assert from "node:assert/strict"
import { sentenceDigest } from "./lib.ts"

// The Done notification is read from a lock screen, so it has to read as a
// complete thought. A digest that stops mid-sentence ("Fixed the login bug
// and then I updated the") is worse than useless.

test("keeps whole sentences and never cuts mid-sentence", () => {
  const digest = sentenceDigest("Fixed the login bug. Updated the tests too. And a third sentence.", {
    maxChars: 45,
  })
  assert.equal(digest, "Fixed the login bug. Updated the tests too.")
})

test("collapses runs of whitespace so the budget isn't wasted", () => {
  const digest = sentenceDigest("Fixed it.\n\n\n  Deployed it.   ", { maxChars: 200 })
  assert.equal(digest, "Fixed it. Deployed it.")
})

test("a single over-long sentence is cut at a word boundary, not mid-word", () => {
  const digest = sentenceDigest("Refactored the entire authentication subsystem and rewired everything", {
    maxChars: 30,
  })
  assert.equal(digest, "Refactored the entire…")
  assert.ok(!digest.startsWith("Refactored the entire a"))
})

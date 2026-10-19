import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePushData, tapData } from "./push-data.ts"

// The plugin sends {category, title, body, sessionId, permissionId} as FCM data.
// Tapping a notification must land on the exact session, and only a permission
// notification offers inline Approve/Reject.

test("a permission ping exposes the session and permission to act on", () => {
  const parsed = parsePushData({
    category: "permissions",
    title: "Permission needed",
    body: "bash: rm -rf build",
    sessionId: "ses_abc",
    permissionId: "per_123",
  })
  assert.equal(parsed.category, "permissions")
  assert.equal(parsed.sessionId, "ses_abc")
  assert.equal(parsed.permissionId, "per_123")
})

test("a question ping deep-links but offers no inline action", () => {
  const parsed = parsePushData({ category: "questions", title: "Question", body: "Which model?", sessionId: "ses_q" })
  assert.equal(parsed.category, "questions")
  assert.equal(parsed.sessionId, "ses_q")
  assert.equal(parsed.permissionId, null)
})

test("unknown or malformed data never throws and never deep-links", () => {
  for (const input of [undefined, null, "nope", 42, {}, { category: "mystery" }]) {
    const parsed = parsePushData(input)
    assert.equal(parsed.category, "unknown")
    assert.equal(parsed.sessionId, null)
    assert.equal(parsed.permissionId, null)
  }
})

test("a tap opens the session it is about", () => {
  assert.deepEqual(tapData({ category: "permissions", sessionId: "ses_abc", permissionId: "per_1" }), {
    sessionId: "ses_abc",
    permissionId: "per_1",
  })
  assert.deepEqual(tapData({ category: "completed", sessionId: "ses_done" }), {
    sessionId: "ses_done",
    permissionId: null,
  })
})

test("a tap is ignored when it names no session to open", () => {
  for (const input of [undefined, null, "nope", {}, { category: "mystery" }, { category: "questions" }]) {
    assert.equal(tapData(input), null, `input: ${JSON.stringify(input)}`)
  }
})

test("a connection notice goes home instead of nowhere", () => {
  assert.deepEqual(tapData({ category: "connection" }), { sessionId: null, permissionId: null })
})

test("an app-local notification still opens its session", () => {
  // "errors" is an app-only category the plugin never sends: the raw field must
  // still be honoured, or failed turns would stop being tappable.
  assert.deepEqual(tapData({ category: "errors", sessionId: "ses_err" }), {
    sessionId: "ses_err",
    permissionId: null,
  })
})

test("a non-permission push never carries a permission to act on", () => {
  assert.equal(tapData({ category: "questions", sessionId: "ses_q", permissionId: "per_sneaky" })?.permissionId, null)
})

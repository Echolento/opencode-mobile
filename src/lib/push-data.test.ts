import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePushData } from "./push-data.ts"

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

import { test } from "node:test"
import assert from "node:assert/strict"
import { ACTION_APPROVE, ACTION_REJECT, extractPushData, isActionable, replyForAction } from "./push-actions.ts"

// What a notification interaction means. Getting this wrong is expensive in a
// specific way: "reject" misread as "approve" runs a command the user refused.

test("approve on the notification means run it once, reject means reject", () => {
  assert.equal(replyForAction(ACTION_APPROVE), "once")
  assert.equal(replyForAction(ACTION_REJECT), "reject")
})

test("a plain tap on the body is not an answer", () => {
  assert.equal(replyForAction("expo.modules.notifications.actions.DEFAULT"), null)
  assert.equal(replyForAction("something-from-a-newer-build"), null)
  assert.equal(replyForAction(null), null)
  assert.equal(replyForAction(undefined), null)
})

test("only a permission with an id can be answered from the lock screen", () => {
  assert.equal(isActionable({ category: "permissions", permissionId: "perm-1" }), true)
  assert.equal(isActionable({ category: "permissions" }), false)
  assert.equal(isActionable({ category: "permissions", permissionId: "" }), false)
  assert.equal(isActionable({ category: "questions", permissionId: "perm-1" }), false)
})

test("data is found in the shape FCM actually delivers", () => {
  assert.deepEqual(extractPushData({ category: "permissions", permissionId: "perm-1", title: "t" }), {
    category: "permissions",
    permissionId: "perm-1",
    title: "t",
  })
})

test("data is found when nested inside a notification response", () => {
  assert.deepEqual(
    extractPushData({
      actionIdentifier: ACTION_APPROVE,
      notification: {
        request: { content: { data: { category: "permissions", permissionId: "perm-9", body: "rm -rf" } } },
      },
    }),
    { category: "permissions", permissionId: "perm-9", body: "rm -rf" },
  )
})

test("a payload the app cannot understand is reported as nothing, not as an empty ping", () => {
  assert.equal(extractPushData({ nothing: "useful" }), null)
  assert.equal(extractPushData(null), null)
  assert.equal(extractPushData("a string"), null)
})

test("non-string values are dropped rather than reaching the notification", () => {
  assert.deepEqual(extractPushData({ category: "permissions", permissionId: "perm-1", count: 3 }), {
    category: "permissions",
    permissionId: "perm-1",
  })
})

test("a self-referencing payload cannot hang the background task", () => {
  const loop: Record<string, unknown> = { category: "questions" }
  loop.self = loop
  assert.deepEqual(extractPushData(loop), { category: "questions" })
})

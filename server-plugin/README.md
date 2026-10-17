# opencode-mobile-push (server-side plugin)

Reliable push notifications for [OpenCode Mobile](../README.md): the app hands its
FCM token to this plugin, and the plugin sends FCM on the events that matter —
**with the app killed**. This is the server half of
[issue #1](https://github.com/Echolento/opencode-mobile/issues/1).

## Why this is needed

The shipped app holds a background SSE socket to fire *local* notifications.
Android suspends background apps, so the socket dies and no notification is ever
scheduled. Real push (FCM) moves that responsibility to the server + the OS push
service, so the app can be cold and still notify you — with **zero background
battery cost**.

## Install

Copy `opencode-mobile-push.ts` into your opencode plugins directory:

```
~/.config/opencode/plugins/opencode-mobile-push.ts
```

## Configure

`~/.config/opencode/mobile-push.json`:

```json
{
  "project": "your-firebase-project-id",
  "keyFile": "~/.config/your-firebase/key.json",
  "port": 4097
}
```

- `keyFile` — a Firebase service-account JSON with the *Firebase Cloud Messaging
  API* enabled and the role to send messages.
- `port` — the plugin listens for token registrations on this port, on the same
  host as the opencode server.

Env overrides: `OPENCODE_PUSH_PROJECT`, `OPENCODE_PUSH_KEY_FILE`, `OPENCODE_PUSH_PORT`.

## What it does

- Serves `POST /push/register` (HTTP Basic, the same `OPENCODE_SERVER_PASSWORD`
  the server uses) to collect device tokens; stores them in
  `~/.config/opencode/mobile-push-tokens.json`.
- On `permission.asked` / `permission.v2.asked` → "Permission needed".
- On the `question` tool → "Question".
- On `session.idle` after real work → "Done".

## App side

The app needs `google-services.json` for its Android package and must be built
with push enabled — see the fork README / issue #1. The app then registers its
token automatically on connect.

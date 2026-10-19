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

Build the plugin and copy **the built file** into your opencode plugins
directory. opencode loads a user plugin as a single module and does not resolve
relative imports between plugin files, so `opencode-mobile-push.ts` (which
imports `./lib`) cannot be copied directly — copying the source silently yields a
plugin that never binds its endpoint.

```
npm run build:plugin    # inlines lib.ts -> server-plugin/dist/opencode-mobile-push.ts
```

```
~/.config/opencode/plugins/opencode-mobile-push.ts   # the built file
```

`lib.ts` stays the source of truth and is unit-tested on its own; the build step
only inlines it. Re-run the build and re-copy after changing either file.

## Configure

`~/.config/opencode/mobile-push.json`:

```json
{
  "project": "your-firebase-project-id",
  "keyFile": "~/.config/opencode/mobile-push-key.json",
  "port": 4097
}
```

- `keyFile` — a Firebase service-account JSON with the *Firebase Cloud Messaging
  API* enabled and the role to send messages.
- `port` — the plugin listens for token registrations on this port, on the same
  host as the opencode server.

Config JSON may have a UTF-8 BOM (PowerShell's `Set-Content -Encoding utf8` adds
one) — it is stripped before parsing, so hand-edits on Windows cannot silently
disable push.

Env overrides: `OPENCODE_PUSH_PROJECT`, `OPENCODE_PUSH_KEY_FILE`,
`OPENCODE_PUSH_PORT`, `OPENCODE_PUSH_CONFIG_FILE`, `OPENCODE_PUSH_TOKENS_FILE`,
`OPENCODE_AFK_STATE_FILE`.

Set `OPENCODE_PUSH_DEBUG=1` to append an init trace (including the resolved
config and the bind result) to `%TEMP%/opencode-mobile-push.log`; plugin logging
inside opencode is otherwise easy to lose.

### `OPENCODE_PUSH_HOST` (required)

The token endpoint only starts in the process that has `OPENCODE_PUSH_HOST` set,
and binds to it. This matters because **every** opencode process (the desktop app
included) loads user plugins from the same directory; without the marker, whichever
process binds `port` first would win it — with the wrong process's credentials —
or starve the real server with `EADDRINUSE`.

Set it in the launcher for `opencode serve`, to the interface the phone reaches
(here, the Tailscale IP):

```powershell
$env:OPENCODE_PUSH_HOST = (tailscale ip -4)
opencode serve --hostname $env:OPENCODE_PUSH_HOST --port 4096
```

The endpoint appears once a session exists (plugins instantiate lazily per
project), so the app retries registration for a short while after connecting.

## What it does

- `POST /push/register` (HTTP Basic, the same `OPENCODE_SERVER_PASSWORD` the
  server uses) collects device tokens; they are stored in
  `~/.config/opencode/mobile-push-tokens.json` and survive restarts.
- `POST /afk/arm` / `POST /afk/disarm` / `GET /afk/state` read and write the same
  `afk/state.json` the `/afk` and `/back` commands use.
- `POST /push/test` sends one real notification to every registered device,
  ignoring AFK state, and reports how many were accepted (`{"ok":true,"sent":1}`).
  The app can only confirm it handed a token over; this is how delivery itself is
  checked.
- `POST /push/ack` lets the app confirm it displayed a data-only push, which
  suppresses the fallback described below.
- On `permission.asked` / `permission.v2.asked` → "Permission needed".
- On the `question` tool → "Question".
- On `session.idle` after real work → "Done", carrying a sentence-aware digest of
  the agent's closing message (whole sentences only, no model call).

All sends fire **only while AFK is armed**; `/back` (laptop) or `POST
/afk/disarm` (phone) silences them. Arming has no expiry — it is intent, and it
survives server restarts. Token registration is not gated, so the device is ready
the moment you arm. Duplicate sends within 20s are suppressed.

Every notification carries `category`/`sessionId` (and `permissionId` for
permission asks) as data, which is what the app deep-links on.

### Permission notifications are sent twice, on purpose

Approve/Reject buttons can only be attached by the app, so a permission ask is
first sent **data-only**: FCM hands it to the app, which builds the notification
and posts the answer back to `/permission/{id}/reply` — no app UI involved, works
with the app killed. The one risk of data-only messages is Android withholding
them while the phone dozes, so the sender waits 8s for `POST /push/ack` and, if
it never comes, re-sends the same content with a notification payload that the OS
renders regardless. You get buttons when the app can act, and a notification
either way.

Questions and Done notices skip all this and are sent as notification payloads
from the start: they are not answered from the lock screen, so there is nothing
to gain by trading reliability for actions.

## App side

The app needs `google-services.json` for its Android package and must be built
with push enabled — see the fork README / issue #1. The app then registers its
token automatically on connect.

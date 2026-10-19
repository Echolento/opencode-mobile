import * as Notifications from "expo-notifications"
import * as Device from "expo-device"
import { Platform, AppState } from "react-native"
import { tapData, type TapData } from "./push-data"
import { registerPushBackground } from "./push-background"

// ---------------------------------------------------------------------------
// Categories — every notification belongs to exactly one
// ---------------------------------------------------------------------------

export const categories = ["permissions", "questions", "completed", "errors", "connection"] as const
export type Category = (typeof categories)[number]

// Per-category metadata used by both the notification module and the settings UI.
// label/description are i18next keys (not display strings) — this module loads
// before i18next is guaranteed to be ready, so callers (e.g. settings.tsx) resolve
// them with t() at render time instead of reading literal text here.
export const categoryMeta: Record<Category, { labelKey: string; descriptionKey: string; icon: string }> = {
  permissions: {
    labelKey: "notifications.categories.permissions.label",
    descriptionKey: "notifications.categories.permissions.description",
    icon: "shield-checkmark",
  },
  questions: {
    labelKey: "notifications.categories.questions.label",
    descriptionKey: "notifications.categories.questions.description",
    icon: "help-circle",
  },
  completed: {
    labelKey: "notifications.categories.completed.label",
    descriptionKey: "notifications.categories.completed.description",
    icon: "checkmark-circle",
  },
  errors: {
    labelKey: "notifications.categories.errors.label",
    descriptionKey: "notifications.categories.errors.description",
    icon: "alert-circle",
  },
  connection: {
    labelKey: "notifications.categories.connection.label",
    descriptionKey: "notifications.categories.connection.description",
    icon: "wifi",
  },
}

// Default state — permissions and questions on (they block work), the rest off
export const defaultPreferences: Record<Category, boolean> = {
  permissions: true,
  questions: true,
  completed: false,
  errors: true,
  connection: true,
}

// ---------------------------------------------------------------------------
// Notification payload — what callers pass in
// ---------------------------------------------------------------------------

export interface Payload {
  category: Category
  title: string
  body: string
  sessionId: string
  dedupeKey?: string
  dedupeCooldownMs?: number
}

// Data embedded in the notification for tap handling
interface NotificationData {
  category: Category
  sessionId: string
}

// ---------------------------------------------------------------------------
// Preferences accessor — injected to avoid circular imports with the store
// ---------------------------------------------------------------------------

type PreferencesAccessor = () => Record<Category, boolean>

let preferences: PreferencesAccessor = () => defaultPreferences
const dedupeSentAt = new Map<string, number>()

export function configure(accessor: PreferencesAccessor) {
  preferences = accessor
}

// ---------------------------------------------------------------------------
// Setup & permissions
// ---------------------------------------------------------------------------

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export async function setup(): Promise<boolean> {
  if (!Device.isDevice) return false

  // Idempotent, and also done on import: registering here means a normal launch
  // still has the action buttons even if the entry point ever changes.
  registerPushBackground()

  const { status: existing } = await Notifications.getPermissionsAsync()
  if (existing === "granted") {
    await ensureChannel()
    return true
  }

  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== "granted") return false

  await ensureChannel()
  return true
}

export async function granted(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync()
  return status === "granted"
}

/** The device's native push token (FCM on Android) used for server-side push.
 *  Returns null when unavailable: not a physical device, permission not yet
 *  granted, or the platform rejected the request. The token is opaque to the
 *  app — it is handed to the server, never interpreted here. */
export async function getDeviceToken(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null
    if (!(await granted())) return null
    const res = await Notifications.getDevicePushTokenAsync()
    const data = res?.data
    return typeof data === "string" ? data : null
  } catch {
    return null
  }
}

/** Subscribe to native push-token rotation (FCM tokens can rotate). Returns an
 *  unsubscribe function. */
export function onDeviceTokenChange(handler: () => void): () => void {
  const sub = Notifications.addPushTokenListener(() => handler())
  return () => sub.remove()
}

async function ensureChannel() {
  if (Platform.OS !== "android") return
  await Notifications.setNotificationChannelAsync("prompts", {
    name: "Session Prompts & Updates",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: "default",
  })
}

// ---------------------------------------------------------------------------
// Send — single entry point, decides whether to fire
// ---------------------------------------------------------------------------

export async function send(payload: Payload) {
  const prefs = preferences()
  if (!prefs[payload.category]) return
  if (AppState.currentState === "active") return
  if (!(await granted())) return

  if (payload.dedupeKey) {
    const now = Date.now()
    const lastSent = dedupeSentAt.get(payload.dedupeKey) || 0
    const cooldown = payload.dedupeCooldownMs ?? 30_000
    if (now - lastSent < cooldown) return
    dedupeSentAt.set(payload.dedupeKey, now)
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: payload.title,
      body: payload.body,
      data: {
        category: payload.category,
        sessionId: payload.sessionId,
      } satisfies NotificationData as Record<string, unknown>,
      sound: "default",
      ...(Platform.OS === "android" ? { channelId: "prompts" } : {}),
    },
    trigger: null,
  })
}

// ---------------------------------------------------------------------------
// Tap handler — returns cleanup function
// ---------------------------------------------------------------------------

// A tap can be delivered twice on a cold start (the response that launched the
// app, then the same one through the listener), and acting twice means pushing
// the same route twice. Notification identifiers are unique per notification,
// so remember the few we have acted on rather than trusting a single source.
const handledTaps = new Set<string>()
const HANDLED_TAP_MEMORY = 20

function handleResponse(response: Notifications.NotificationResponse, handler: (data: TapData) => void) {
  const id = response?.notification?.request?.identifier
  if (id) {
    if (handledTaps.has(id)) return
    handledTaps.add(id)
    if (handledTaps.size > HANDLED_TAP_MEMORY) {
      const oldest = handledTaps.values().next().value
      if (oldest) handledTaps.delete(oldest)
    }
  }

  // tapData also decides whether this tap is actionable at all: a push that
  // names no session is ignored rather than navigating on a guess.
  const data = tapData(response?.notification?.request?.content?.data)
  if (data) handler(data)
}

export function onTap(handler: (data: TapData) => void) {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    handleResponse(response, handler)
  })

  // A tap that *launched* the app is delivered before this listener can exist
  // (it is registered on first render), so the cold-start response has to be
  // drained explicitly — otherwise tapping a push while the app is killed opens
  // the app on the wrong screen, which is the common case for server pushes.
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) handleResponse(response, handler)
    })
    .catch(() => undefined)

  return () => subscription.remove()
}

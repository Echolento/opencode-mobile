import * as SecureStore from "expo-secure-store"

// What the background task needs to act on a notification while no screen is
// alive: which server to talk to, with which credentials. The task runs without
// the connection store, so an active connection held only in memory is not
// enough — and the server address cannot travel in the notification itself,
// because FCM payloads pass through Google.

const PUSH_TARGET_KEY = "opencode_push_target"

export type PushTarget = {
  url: string
  username?: string | null
  password?: string | null
  directory?: string | null
}

export async function setPushTarget(target: PushTarget): Promise<void> {
  try {
    await SecureStore.setItemAsync(PUSH_TARGET_KEY, JSON.stringify(target))
  } catch {
    // A missing target only costs the ability to answer from the lock screen;
    // the notification itself still arrives.
  }
}

export async function getPushTarget(): Promise<PushTarget | null> {
  try {
    const raw = await SecureStore.getItemAsync(PUSH_TARGET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PushTarget
    if (!parsed || typeof parsed.url !== "string" || !parsed.url) return null
    return parsed
  } catch {
    return null
  }
}

export async function clearPushTarget(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PUSH_TARGET_KEY)
  } catch {}
}

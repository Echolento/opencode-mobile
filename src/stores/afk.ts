import { create } from "zustand"
import { armAfk, disarmAfk, fetchAfkState } from "../lib/push"
import type { AfkSnapshot } from "../lib/afk-state"

// Whether the server is currently pinging this phone, mirroring /afk and /back
// on the laptop (one shared state file, so both sides agree).
//
// The server is the source of truth — this only caches its answer for the UI, so
// every mutation re-reads the server rather than assuming the call worked. A
// failed read leaves the previous answer alone: "unknown" must never be shown as
// "off", or an armed session would look disarmed and the user would trust a
// silence that is actually a broken endpoint.
interface AfkState extends AfkSnapshot {
  checked: boolean
  busy: boolean
  refresh: () => Promise<void>
  arm: () => Promise<void>
  disarm: () => Promise<void>
}

export const useAfk = create<AfkState>((set, get) => ({
  armed: false,
  armedAt: null,
  checked: false,
  busy: false,

  refresh: async () => {
    const snapshot = await fetchAfkState()
    if (snapshot) set({ ...snapshot, checked: true })
  },

  arm: async () => {
    if (get().busy) return
    set({ busy: true })
    try {
      await armAfk()
      const snapshot = await fetchAfkState()
      if (snapshot) set({ ...snapshot, checked: true })
    } finally {
      set({ busy: false })
    }
  },

  disarm: async () => {
    if (get().busy) return
    set({ busy: true })
    try {
      await disarmAfk()
      const snapshot = await fetchAfkState()
      // A disarm that could not be confirmed must not fake a success: show the
      // server's answer, or keep the last one if the server said nothing.
      if (snapshot) set({ ...snapshot, checked: true })
    } finally {
      set({ busy: false })
    }
  },
}))

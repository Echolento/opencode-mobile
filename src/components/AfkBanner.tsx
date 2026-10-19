/**
 * "Your phone is being pinged" — the visible half of /afk.
 *
 * Arming is invisible by design (the phone arms it just by sending a prompt, so
 * the user is usually not looking at the app when it happens), which makes an
 * armed session silent-but-loud: notifications keep arriving hours later and
 * there is nothing on screen explaining why, or how to stop them. This strip is
 * that explanation and that off-switch.
 *
 * Renders nothing when the server says the session is not armed, which is the
 * common case — one hook and no pixels, like UpdateBanner.
 */

import { useCallback, useState } from "react"
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useFocusEffect } from "expo-router"
import { useAfk } from "../stores/afk"

export function AfkBanner({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation()
  const armed = useAfk((state) => state.armed)
  const busy = useAfk((state) => state.busy)
  const [error, setError] = useState(false)

  // The server may have been armed or disarmed from the laptop since this screen
  // was last shown (or since the app was last foregrounded), so ask again every
  // time the screen gains focus rather than once per mount.
  useFocusEffect(
    useCallback(() => {
      void useAfk.getState().refresh()
    }, []),
  )

  if (!armed) return null

  const onDisarm = async () => {
    setError(false)
    await useAfk.getState().disarm()
    // Still armed after asking to stop: the endpoint is unreachable, and saying
    // nothing would leave the user believing pings are off when they are not.
    if (useAfk.getState().armed) setError(true)
  }

  return (
    <View style={[styles.banner, isDark && styles.bannerDark]} testID="afk-banner">
      <Ionicons name="notifications" size={20} color={isDark ? "#fcd34d" : "#b45309"} />
      <View style={styles.text}>
        <Text style={[styles.title, isDark && styles.titleDark]}>{t("afk.armedTitle")}</Text>
        <Text style={[styles.body, isDark && styles.bodyDark]} numberOfLines={2}>
          {error ? t("afk.disarmFailed") : t("afk.armedBody")}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={isDark ? "#fcd34d" : "#b45309"} />
      ) : (
        <TouchableOpacity onPress={onDisarm} testID="afk-banner-disarm" hitSlop={8}>
          <Text style={[styles.action, isDark && styles.actionDark]}>{t("afk.stop")}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#fef3c7",
  },
  bannerDark: {
    backgroundColor: "#3b2f0b",
  },
  text: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#78350f",
  },
  titleDark: {
    color: "#fef3c7",
  },
  body: {
    fontSize: 12,
    color: "#b45309",
  },
  bodyDark: {
    color: "#d6c089",
  },
  action: {
    fontSize: 14,
    fontWeight: "600",
    color: "#b45309",
  },
  actionDark: {
    color: "#fcd34d",
  },
})

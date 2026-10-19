// Port the opencode-mobile-push plugin listens on (same host as the server).
export const PUSH_PORT = 4097

/** Derive a plugin endpoint URL from the opencode server's base URL: keep the
 *  scheme and host, swap the port for the plugin's, and replace the path. Any
 *  query/hash from the server URL is dropped. Returns null if the base URL is
 *  unusable (caller treats that as "no plugin here"). */
export function pluginUrlFromBase(baseUrl: string, path: string, port = PUSH_PORT): string | null {
  try {
    const url = new URL(baseUrl)
    url.port = String(port)
    url.pathname = path
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

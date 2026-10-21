// Which notifications belong to the server rather than to this app.
//
// The server pushes prompts and completions itself, and it is the only side
// that can tell a real prompt from noise: opencode emits `permission.asked`
// before rules decide, so a request that is auto-allowed looks identical to one
// that blocks the agent until you ask the server what is still pending. It is
// also the only side that knows whether /afk is armed. Anything scheduled here
// as well therefore arrives twice, and arrives whether or not the user asked to
// be pinged — so only transport problems (which the server cannot report about
// itself) stay local.
const SERVER_OWNED: ReadonlySet<string> = new Set(["permissions", "questions", "completed"])

export function serverOwns(category: string): boolean {
  return SERVER_OWNED.has(category)
}

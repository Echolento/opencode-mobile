// Push handling has to be in place before the router renders, because a
// notification can launch this JS with no screen at all (headless) — and a task
// defined by a component would not exist in that launch.
import "./src/lib/push-background"

import "expo-router/entry"

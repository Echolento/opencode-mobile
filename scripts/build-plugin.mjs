// Bundles the tested server module (lib.ts) into the plugin file so the result
// is a single self-contained file.
//
// Why this exists: opencode loads each user plugin as one module and does not
// resolve relative imports between plugin files, so a plugin that does
// `import ... from "./lib"` fails to load — taking the HTTP endpoint down with
// it. lib.ts stays the source of truth (and stays unit-tested on its own); this
// step inlines it.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const fail = (message) => {
  console.error(`build-plugin: ${message}`)
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const srcDir = path.join(root, "server-plugin")
const read = (file) => fs.readFileSync(path.join(srcDir, file), "utf8")

// Only lib.ts is inlined, so only its top-level exports lose the keyword.
const stripExports = (ts) => ts.replace(/^export /gm, "")

// Both files import node builtins; declaring the same binding twice in one
// module is a SyntaxError, so imports are hoisted and deduped by line.
const importLines = (ts) => {
  const lines = ts.match(/^import .*$/gm) ?? []
  for (const line of lines) {
    if (!/["']$/.test(line)) fail(`multi-line import is not supported: ${line}`)
  }
  return lines.filter((line) => !line.includes('"./'))
}
const stripImports = (ts) => ts.replace(/^import .*$\n?/gm, "")

const lib = read("lib.ts")
const plugin = read("opencode-mobile-push.ts")

const imports = [...new Set([...importLines(lib), ...importLines(plugin)])]
const libBody = stripExports(stripImports(lib)).trim()
const pluginBody = stripImports(plugin).trim()

const banner = `// GENERATED FILE — do not edit.
// Built from server-plugin/{lib,opencode-mobile-push}.ts by \`npm run build:plugin\`.
// opencode does not resolve relative imports between plugin files, so lib.ts is
// inlined here to keep the plugin self-contained.

`

const out = `${banner}${imports.join("\n")}\n\n${libBody}\n\n${pluginBody}\n`

if (/from "\.\//.test(out)) fail("output still contains a relative import")
if (!out.includes("OpenCodeMobilePushPlugin")) fail("plugin export missing from output")
if (!out.includes("createPushServer")) fail("lib.ts was not inlined")

const distDir = path.join(srcDir, "dist")
fs.mkdirSync(distDir, { recursive: true })
fs.writeFileSync(path.join(distDir, "opencode-mobile-push.ts"), out)
console.log(`built server-plugin/dist/opencode-mobile-push.ts (${out.length} bytes)`)

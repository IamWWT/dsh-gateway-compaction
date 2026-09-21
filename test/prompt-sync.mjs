/**
 * Prompt-synchronization test: the settings page shows the exact prompt text
 * that shapes compaction quality (client.js, display-only copies). The host
 * (index.js) is the source of truth for what is actually SENT. This test
 * asserts the two halves stay in lockstep:
 *
 *   - client SUPPLEMENT_TEXT  === host SUMMARY_SUPPLEMENT (byte-exact: the
 *     supplement is display-AND-wire text, identical for both surfaces)
 *   - client MERGE_PREAMBLE_TEXT STARTS WITH the host MERGE_PREAMBLE (the wire
 *     preamble; the display copy appends a worked example of the per-slice
 *     partials after it)
 *
 * Extracted from client.js by locating the template-literal constants (the
 * client is a classic IIFE script and cannot be imported by node).
 *
 * Run: node test/prompt-sync.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))

const { SUMMARY_SUPPLEMENT, MERGE_PREAMBLE } = await import("../index.js")

const clientSrc = readFileSync(join(here, "..", "client.js"), "utf8")

function extractTemplate(name) {
  const marker = `const ${name} = \``
  const start = clientSrc.indexOf(marker)
  assert.notEqual(start, -1, `${name} template constant not found in client.js`)
  const bodyStart = start + marker.length
  const end = clientSrc.indexOf("`;", bodyStart)
  assert.notEqual(end, -1, `unterminated template literal for ${name}`)
  return clientSrc.slice(bodyStart, end)
}

let passed = 0
let failed = 0
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok    ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label} ${detail}`) }
}

// 1. Supplement: the displayed text must be exactly what the host appends.
const clientSupplement = extractTemplate("SUPPLEMENT_TEXT")
check(
  "client SUPPLEMENT_TEXT is byte-identical to host SUMMARY_SUPPLEMENT",
  clientSupplement === SUMMARY_SUPPLEMENT,
  `diverged — update client.js (or the host); diff length client=${clientSupplement.length} host=${SUMMARY_SUPPLEMENT.length}`,
)

// 2. Merge preamble: the wire preamble (host) must be the display text's prefix;
//    everything after it is display-only illustration.
const clientMerge = extractTemplate("MERGE_PREAMBLE_TEXT")
check(
  "client MERGE_PREAMBLE_TEXT starts with the host's wire MERGE_PREAMBLE",
  clientMerge.startsWith(MERGE_PREAMBLE),
  "the displayed merge preamble no longer matches what the host sends",
)
check(
  "display merge block still documents the per-slice partials",
  clientMerge.includes("Partial checkpoint 1 of N"),
)

console.log(`prompt-sync: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
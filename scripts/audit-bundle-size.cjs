#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const distDir = path.resolve(__dirname, "..", "apps", "ui", "dist")
const assetsDir = path.join(distDir, "assets")
const mb = 1024 * 1024
const budgets = {
  totalJs: Number(process.env.BUNDLE_TOTAL_JS_MB || "38") * mb,
  // Raised from 1.75 MB when the terminal, steering, pull requests, chat
  // find, model comparison, resume and the sidebar's folders, pins and
  // snoozes landed (2.06 MB). On-demand pages and dialogs stay lazy; what
  // the first paint needs (sidebar, composer, queue) is in the entry.
  entry: Number(process.env.BUNDLE_ENTRY_MB || "2.25") * mb,
  markdown: Number(process.env.BUNDLE_MARKDOWN_MB || "2") * mb,
  typeScriptWorker: Number(process.env.BUNDLE_TS_WORKER_MB || "6.25") * mb,
  // What the browser must download and parse before the first frame. Total
  // size alone never caught the real regression: a 19 MB shiki chunk sat on
  // the critical path for months while every other budget stayed green,
  // because lazy and eager bytes were counted the same.
  eager: Number(process.env.BUNDLE_EAGER_MB || "5") * mb,
}

if (!fs.existsSync(assetsDir)) {
  throw new Error(`Renderer assets not found: ${assetsDir}`)
}

const files = fs
  .readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetsDir, name)).size }))
const totalJs = files.reduce((total, file) => total + file.bytes, 0)
const entry = largestMatching(files, /^index-.*\.js$/)
const markdown = largestMatching(files, /^vendor-markdown-.*\.js$/)
const typeScriptWorker = largestMatching(files, /^ts\.worker-.*\.js$/)
const checks = [
  ["total JavaScript", totalJs, budgets.totalJs],
  ["entry chunk", entry, budgets.entry],
  ["markdown chunk", markdown, budgets.markdown],
  ["TypeScript worker", typeScriptWorker, budgets.typeScriptWorker],
  ["eager (pre-first-paint)", eagerBytes(), budgets.eager],
]

let failed = false
for (const [label, bytes, budget] of checks) {
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(`Invalid ${label} budget: expected a finite non-negative number`)
  }
  const status = bytes <= budget ? "ok" : "OVER"
  process.stdout.write(
    `[bundle-size] ${status} ${label}: ${formatMb(bytes)} MB / ${formatMb(budget)} MB\n`,
  )
  if (bytes > budget) failed = true
}
if (failed) process.exitCode = 1

/**
 * Everything `index.html` pulls in up front: the entry script, its
 * `modulepreload` graph, and the stylesheet. Chunks reached only through a
 * dynamic `import()` are absent from that list, which is exactly the
 * distinction this budget exists to enforce.
 */
function eagerBytes() {
  const indexHtml = path.join(distDir, "index.html")
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Renderer entry HTML not found: ${indexHtml}`)
  }
  const html = fs.readFileSync(indexHtml, "utf8")
  const referenced = new Set(
    [...html.matchAll(/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g)].map((m) => m[0]),
  )
  let total = 0
  for (const relativePath of referenced) {
    const filePath = path.join(distDir, relativePath)
    if (fs.existsSync(filePath)) total += fs.statSync(filePath).size
  }
  return total
}

function largestMatching(candidates, pattern) {
  return candidates
    .filter((file) => pattern.test(file.name))
    .reduce((largest, file) => Math.max(largest, file.bytes), 0)
}

function formatMb(bytes) {
  return (bytes / mb).toFixed(2)
}

#!/usr/bin/env node

// Fast CI gate for the contributor entry points and the desktop theme contract.
// Uses Node built-ins so forked pull requests can run it without npm ci.

import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const errors = []

function read(file) {
  try {
    return fs.readFileSync(path.join(root, file), "utf8")
  } catch {
    errors.push(`Missing required file: ${file}`)
    return ""
  }
}

function block(source, marker, label) {
  const match = marker.exec(source)
  if (!match) {
    errors.push(`Cannot find ${label}`)
    return ""
  }
  const open = source.indexOf("{", match.index)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] === "}") depth -= 1
    if (depth === 0) return source.slice(open + 1, index)
  }
  errors.push(`Unclosed block: ${label}`)
  return ""
}

function declarations(source) {
  return new Map(
    [...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ])
  )
}

function quotedTokens(source) {
  return new Set(
    [...source.matchAll(/"(--[\w-]+)"\s*:/g)].map((match) => match[1])
  )
}

function quotedDeclarations(source) {
  return new Map(
    [...source.matchAll(/"(--[\w-]+)"\s*:\s*"([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ])
  )
}

function compareTokens(label, actual, expected) {
  const missing = [...expected].filter((token) => !actual.has(token))
  const extra = [...actual].filter((token) => !expected.has(token))
  if (missing.length || extra.length) {
    errors.push(
      `${label}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`
    )
  }
}

const agentGuide = read("AGENTS.md")
for (const file of [
  "CONTRIBUTING.md",
  "docs/development/ci.md",
  ".github/workflows/ci.yml",
  "BRAND.md",
  "docs/design-system.md",
  "apps/mobile/DESIGN.md",
]) {
  read(file)
  if (!agentGuide.includes(file)) errors.push(`AGENTS.md must link to ${file}`)
}
for (const file of [
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
]) {
  if (!read(file).includes("AGENTS.md"))
    errors.push(`${file} must point to AGENTS.md`)
}
const prTemplate = read(".github/PULL_REQUEST_TEMPLATE.md")
if (
  !prTemplate.includes("AGENTS.md") ||
  !prTemplate.includes("docs/design-system.md")
) {
  errors.push("The pull request template must link to the agent and UI guides")
}

const css = read("apps/ui/src/index.css")
const inline = declarations(block(css, /@theme\s+inline\s*\{/, "@theme inline"))
const light = declarations(block(css, /:root\s*\{/, ":root"))
const dark = declarations(block(css, /(?:^|\n)\.dark\s*\{/, ".dark"))
const colorTokens = new Set()
for (const [alias, value] of inline) {
  if (!alias.startsWith("--color-")) continue
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  if (!token) {
    errors.push(`${alias} must reference a semantic CSS variable`)
    continue
  }
  colorTokens.add(token)
  for (const [mode, vars] of [
    ["light", light],
    ["dark", dark],
  ]) {
    if (!vars.has(token))
      errors.push(`${mode} CSS is missing ${token}, used by ${alias}`)
  }
}
if (colorTokens.size === 0) errors.push("No Tailwind color aliases found")

const appearance = read("apps/ui/src/lib/appearance-store.ts")
const templateArray =
  /export const THEME_TEMPLATES: ThemeTemplate\[\] = \[([\s\S]*?)\n\]/.exec(
    appearance
  )?.[1] ?? ""
if (!templateArray) errors.push("Cannot find built-in theme templates")
const templateIds = [...templateArray.matchAll(/\bid:\s*"([^"]+)"/g)].map(
  (match) => match[1]
)
const templates = new Map(
  [
    ...templateArray.matchAll(
      /\bid:\s*"([^"]+)"[\s\S]*?\bvars:\s*\{([^}]*)\}/g
    ),
  ].map((match) => [
    match[1],
    { keys: quotedTokens(match[2]), vars: quotedDeclarations(match[2]) },
  ])
)
if (templates.size !== templateIds.length)
  errors.push("Every built-in theme must declare a vars object")
const baseline = templates.get("default-dark")?.keys ?? new Set()
if (!templates.has("default-dark") || !templates.has("white")) {
  errors.push("Default Dark and White templates are required")
}
if (baseline.size === 0)
  errors.push("Default Dark declares no workbench tokens")
for (const [id, { keys }] of templates) {
  compareTokens(`Theme ${id}`, keys, baseline)
}
for (const token of baseline) {
  if (!light.has(token) || !dark.has(token)) {
    errors.push(
      `${token} from the built-in templates needs light and dark CSS fallbacks`
    )
  }
}

const imported = read("apps/ui/src/lib/vscode-theme.ts")
const importedVars = block(
  imported.slice(imported.indexOf("export function themeToCssVars(")),
  /\n  return\s*\{/,
  "themeToCssVars return value"
)
compareTokens("Imported VS Code theme", quotedTokens(importedVars), baseline)

for (const [id, fallback] of [
  ["default-dark", dark],
  ["white", light],
]) {
  const vars = templates.get(id)?.vars
  if (!vars) continue
  for (const [token, value] of vars) {
    if (fallback.get(token) !== value) {
      errors.push(`${id} ${token} differs from its CSS fallback`)
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `Contributor guides and ${baseline.size} shared workbench tokens are in sync.`
  )
}

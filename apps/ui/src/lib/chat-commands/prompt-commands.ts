import { parseCliArgs } from "@/lib/cli-parse"
import { listProjectConfigSettings } from "@/services/backend/workspaceApi"
import { resolveProjectCommandAgent } from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"

type BetterC0deDefaultCommandPrompt = {
  id: "init" | "review"
  prompt: string
  chatModeOverride?: string
  permissionLevelOverride?: string
}

export function isSlashCommand(command: string, ...names: string[]): boolean {
  return names.some((name) => command === `/${name}`)
}

export function buildBetterC0deDefaultCommandPrompt(
  text: string,
  runtimePath?: string | null
): BetterC0deDefaultCommandPrompt | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const command = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ""
  const args = trimmed.slice(command.length).trim()
  if (isSlashCommand(command, "init", "session.init")) {
    return {
      id: "init",
      prompt: buildBetterC0deInitPrompt(args, runtimePath),
    }
  }
  if (isSlashCommand(command, "review")) {
    return {
      id: "review",
      prompt: buildBetterC0deReviewPrompt(args, runtimePath),
      chatModeOverride: "ask",
      permissionLevelOverride: "read-only",
    }
  }
  if (
    isSlashCommand(
      command,
      "pr",
      "pull-request",
      "gh-pr",
      "github.pr",
      "github-pr"
    )
  ) {
    return {
      id: "review",
      prompt: buildBetterC0dePrReviewPrompt(args, runtimePath),
      chatModeOverride: "ask",
      permissionLevelOverride: "read-only",
    }
  }
  return null
}

export function buildBetterC0dePrTerminalOutput(
  command: string,
  runtimePath?: string | null
): string {
  const validation = buildBetterC0dePrTerminalValidationMessages(command)
  return [
    "# BetterC0de PR",
    "",
    "Compatibility reference: `betterc0de pr <number>`.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "```sh",
    command,
    "```",
    validation.length > 0
      ? [
          "",
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
        ].join("\n")
      : "",
    "",
    "> Opened the terminal panel with this command prefilled. Press Enter there only when you intentionally want BetterC0de to fetch and checkout the PR branch.",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0dePrTerminalValidationMessages(
  command: string
): string[] {
  const rest = command.replace(/^betterc0de\s+pr\b/i, "").trim()
  const [target] = parseCliArgs(rest)
  if (!target) return ["BetterC0de PR requires a PR number."]
  if (/^\d+$/.test(target)) return []
  return ["BetterC0de PR target must be a numeric PR number."]
}

function buildBetterC0deInitPrompt(
  argumentsText: string,
  runtimePath?: string | null
): string {
  const focus = argumentsText || "(none provided)"
  const workspace = runtimePath || "(no workspace folder is currently open)"
  return [
    "Create or update `AGENTS.md` for this repository.",
    "",
    `Workspace path: ${workspace}`,
    "",
    'The goal is a compact instruction file that helps future BetterC0de/BetterC0de-compatible agent sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.',
    "",
    "User-provided focus or constraints (honor these):",
    focus,
    "",
    "## How to investigate",
    "",
    "Read the highest-value sources first:",
    "- `README*`, root manifests, workspace config, lockfiles",
    "- build, test, lint, formatter, typecheck, and codegen config",
    "- CI workflows and pre-commit/task-runner config",
    "- existing instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`)",
    "- repo-local agent config such as `betterc0de.json` or BetterC0de/Codex config files",
    "",
    "If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer files that explain wiring over random leaf files.",
    "",
    "Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust executable source and only keep what you can verify.",
    "",
    "## What to extract",
    "",
    "Look for the highest-signal facts for an agent working in this repo:",
    "- exact developer commands, especially non-obvious ones",
    "- how to run a single test, a single package, or a focused verification step",
    "- required command order when it matters, such as `lint -> typecheck -> test`",
    "- monorepo or multi-package boundaries, ownership of major directories, and real app/library entrypoints",
    "- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow",
    "- repo-specific style or workflow conventions that differ from defaults",
    "- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites",
    "- important constraints from existing instruction files worth preserving",
    "",
    "Good `AGENTS.md` content is usually hard-earned context that took reading multiple files to infer.",
    "",
    "## Questions",
    "",
    "Only ask the user questions if the repo cannot answer something important. Use one short batch at most.",
    "",
    "Good questions:",
    "- undocumented team conventions",
    "- branch / PR / release expectations",
    "- missing setup or test prerequisites that are known but not written down",
    "",
    "Do not ask about anything the repo already makes clear.",
    "",
    "## Writing rules",
    "",
    "Include only high-signal, repo-specific guidance such as:",
    "- exact commands and shortcuts the agent would otherwise guess wrong",
    "- architecture notes that are not obvious from filenames",
    "- conventions that differ from language or framework defaults",
    "- setup requirements, environment quirks, and operational gotchas",
    "- references to existing instruction sources that matter",
    "",
    "Exclude:",
    "- generic software advice",
    "- long tutorials or exhaustive file trees",
    "- obvious language conventions",
    "- speculative claims or anything you could not verify",
    "- content better stored in another file referenced via config `instructions`",
    "",
    "When in doubt, omit.",
    "",
    "Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.",
    "",
    `If \`AGENTS.md\` already exists at ${workspace}, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase.`,
    "",
    "If no workspace folder is open, do not create files. Explain that a workspace is required first.",
  ].join("\n")
}

function buildBetterC0deReviewPrompt(
  argumentsText: string,
  runtimePath?: string | null
): string {
  const input =
    argumentsText || "(no arguments; review all uncommitted changes)"
  const workspace = runtimePath || "(no workspace folder is currently open)"
  return [
    "You are a code reviewer. Your job is to review code changes and provide actionable feedback.",
    "",
    `Workspace path: ${workspace}`,
    "",
    "---",
    "",
    `Input: ${input}`,
    "",
    "---",
    "",
    "## Determining What to Review",
    "",
    "Based on the input provided, determine which type of review to perform:",
    "",
    "1. No arguments (default): Review all uncommitted changes",
    "   - Run: `git diff` for unstaged changes",
    "   - Run: `git diff --cached` for staged changes",
    "   - Run: `git status --short` to identify untracked files",
    "",
    "2. Commit hash: Review that specific commit",
    "   - Run: `git show <commit>`",
    "",
    "3. Branch name: Compare current branch to the specified branch",
    "   - Run: `git diff <branch>...HEAD`",
    "",
    "4. PR URL or number: Review the pull request",
    "   - Run: `gh pr view <target>` for PR context",
    "   - Run: `gh pr diff <target>` for the diff",
    "",
    "Use best judgment when processing input.",
    "",
    "## Gathering Context",
    "",
    "Diffs alone are not enough. After getting the diff, read the entire file(s) being modified to understand full context. Code that looks wrong in isolation may be correct given surrounding logic, and vice versa.",
    "",
    "- Use the diff to identify which files changed",
    "- Use `git status --short` to identify untracked files, then read their full contents",
    "- Read full files to understand existing patterns, control flow, and error handling",
    "- Check for existing style guide or conventions files (`CONVENTIONS.md`, `AGENTS.md`, `.editorconfig`, etc.)",
    "",
    "## What to Look For",
    "",
    "Bugs - Your primary focus.",
    "- Logic errors, off-by-one mistakes, incorrect conditionals",
    "- Missing guards, incorrect branching, unreachable code paths",
    "- Null/empty/undefined inputs, error conditions, race conditions",
    "- Security issues: injection, auth bypass, data exposure",
    "- Broken error handling that swallows failures, throws unexpectedly, or returns error types that are not caught",
    "",
    "Structure - Does the code fit the codebase?",
    "- Does it follow existing patterns and conventions?",
    "- Are there established abstractions it should use but does not?",
    "- Is there excessive nesting that could be flattened with early returns or extraction?",
    "",
    "Performance - Only flag if obviously problematic.",
    "- O(n^2) on unbounded data, N+1 queries, blocking I/O on hot paths",
    "",
    "Behavior Changes - If a behavioral change is introduced, raise it, especially if it may be unintentional.",
    "",
    "## Before You Flag Something",
    "",
    "Be certain. If you call something a bug, you need to be confident it actually is one.",
    "",
    "- Only review the changes; do not review pre-existing code that was not modified",
    "- Do not flag something as a bug if you are unsure; investigate first",
    "- Do not invent hypothetical problems; if an edge case matters, explain the realistic scenario where it breaks",
    "- If you need more context to be sure, use tools to get it",
    "",
    "Do not turn style preferences into review findings unless they clearly violate established project conventions or hide real risk.",
    "",
    "## Output",
    "",
    "1. Findings first, ordered by severity, with concrete file/line references where possible.",
    "2. If there is a bug, be direct and clear about why it is a bug.",
    "3. Clearly communicate severity and the scenario needed for the issue to matter.",
    "4. Keep the tone matter-of-fact and actionable.",
    "5. If there are no findings, say so clearly and mention residual risk or test gaps.",
    "",
    "If no workspace folder is open, do not run review commands. Explain that a workspace is required first.",
  ].join("\n")
}

function buildBetterC0dePrReviewPrompt(
  argumentsText: string,
  runtimePath?: string | null
): string {
  const target = argumentsText.trim()
  return [
    "BetterC0de `pr <number>` compatibility mode.",
    "",
    "BetterC0de will review the pull request in read-only Ask mode. Do not checkout branches, add remotes, force-checkout, push, or start another CLI process unless the user explicitly asks for that mutation.",
    "the compatibility CLI's native PR command also scans the PR body for shared `https://opncd.ai/s/<id>` session links and imports them before starting. In BetterC0de, inspect the PR body for such a link and recommend `/import <url>` instead of importing or mutating history automatically.",
    "",
    target
      ? `PR target: ${target}`
      : "PR target: (none provided; ask the user for a PR number or URL before running GitHub commands)",
    "",
    buildBetterC0deReviewPrompt(target || "(PR target missing)", runtimePath),
  ].join("\n")
}

export async function buildBetterC0deDefaultAgentContext(
  runtimePath?: string | null
): Promise<string | null> {
  if (!runtimePath) return null
  let defaultAgent: string | undefined
  try {
    const settings = await listProjectConfigSettings(runtimePath)
    defaultAgent = settings.find(
      (setting) => setting.key === "default_agent"
    )?.value
  } catch {
    return null
  }
  const agent = defaultAgent
    ? await resolveProjectCommandAgent(defaultAgent, runtimePath, {
        includePrimaryBuild: true,
      })
    : null
  if (!agent?.prompt) return null
  return [
    `[BetterC0de default agent: ${agent.name || agent.id}]`,
    "```",
    agent.prompt,
    "```",
  ].join("\n")
}

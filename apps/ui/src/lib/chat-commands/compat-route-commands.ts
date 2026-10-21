import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import {
  type ActiveThreadRef,
  escapeInlineCode,
  escapeMarkdownTableCell,
} from "./provider-config"
import {
  betterC0deInternalRouteGuidance,
  betterC0deTuiCommandEquivalent,
} from "./runtime-commands"

export function buildBetterC0deInternalRouteOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const route = command.replace(/^\//, "")
  if (route === "project.initGit") {
    return buildBetterC0deProjectInitGitOutput(args)
  }
  if (route === "tui.publish") {
    return buildBetterC0deTuiPublishOutput(args)
  }
  const guidance = betterC0deInternalRouteGuidance(route, args)
  return [
    "# BetterC0de Internal Route\n",
    `Route: \`${escapeInlineCode(route)}\``,
    "",
    `BetterC0de equivalent: ${guidance.equivalent}`,
    guidance.reason ? `Reason: ${guidance.reason}` : "",
    args.length > 0 ? `Arguments: \`${escapeInlineCode(args.join(" "))}\`` : "",
    "",
    "> This route is reserved for compatibility identifiers. BetterC0de only executes the safe local equivalent; provider credentials, raw websocket sync, message-part mutation, and internal terminal UI events are not run from chat.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildBetterC0deInternalRouteTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const route = command.replace(/^\//, "")
  if (route !== "project.initGit") {
    return { command: "", shouldOpen: false }
  }
  return {
    command: "git init",
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deProjectInitGitOutput(
  args: ReadonlyArray<string>
): string {
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  return [
    "# BetterC0de Project Git Init",
    "",
    "Compatibility reference: `project.initGit` / `POST /project/git/init`.",
    "",
    "```sh",
    "git init",
    "```",
    "",
    "BetterC0de equivalent: the integrated terminal in the active workspace.",
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with `git init` prefilled. Press Enter there to initialize Git intentionally."
      : "> Git initialization is a filesystem mutation. Add `--terminal` to open the integrated terminal with `git init` prefilled.",
  ].join("\n")
}

type BetterC0deTuiPublishEvent = {
  type: string
  properties: Record<string, unknown>
}

function buildBetterC0deTuiPublishOutput(args: ReadonlyArray<string>): string {
  const parsed = parseBetterC0deTuiPublishEvent(args)
  const validation = parsed.event
    ? validateBetterC0deTuiPublishEvent(parsed.event)
    : parsed.validation
  const event = parsed.event
  const equivalent = event
    ? betterC0deTuiPublishEquivalent(event)
    : "Provide a `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, or `tui.session.select` payload."

  return [
    "# BetterC0de Terminal Event Publish",
    "",
    "Compatibility reference: `tui.publish` / `POST /tui/publish`.",
    "",
    event
      ? [
          "| Field | Value |",
          "|:------|:------|",
          `| Event | \`${escapeMarkdownTableCell(event.type)}\` |`,
          `| Properties | \`${escapeMarkdownTableCell(JSON.stringify(event.properties))}\` |`,
          `| BetterC0de equivalent | ${equivalent} |`,
        ].join("\n")
      : `BetterC0de equivalent: ${equivalent}`,
    validation.length > 0 ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length > 0 ? "" : "",
    '> Accepted forms: `/tui.publish {"type":"tui.command.execute","properties":{"command":"session.list"}}`, `/tui.publish tui.command.execute session.list`, `/tui.publish --type=tui.prompt.append --text "hello"`, `/tui.publish --message Saved --variant success`, or `/tui.publish tui.session.select ses_...`.',
  ]
    .filter(Boolean)
    .join("\n")
}

function parseBetterC0deTuiPublishEvent(args: ReadonlyArray<string>): {
  event: BetterC0deTuiPublishEvent | null
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (!raw) {
    return {
      event: null,
      validation: ["Missing TUI publish event payload."],
    }
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isBetterC0deTuiPublishEvent(parsed)) {
        return { event: parsed, validation: [] }
      }
      return {
        event: null,
        validation: [
          "JSON payload must include a string `type` and object `properties`.",
        ],
      }
    } catch (error) {
      return {
        event: null,
        validation: [
          `Invalid JSON payload: ${error instanceof Error ? error.message : "parse failed"}.`,
        ],
      }
    }
  }

  const type =
    readBetterC0deTuiPublishOption(args, "type", "event") ??
    inferBetterC0deTuiPublishType(args)
  const properties = parseBetterC0deTuiPublishProperties(type, args)
  if (!type) {
    return {
      event: null,
      validation: ["Missing TUI publish event type."],
    }
  }
  return { event: { type, properties }, validation: [] }
}

function isBetterC0deTuiPublishEvent(
  value: unknown
): value is BetterC0deTuiPublishEvent {
  if (!value || typeof value !== "object") return false
  const event = value as { type?: unknown; properties?: unknown }
  return (
    typeof event.type === "string" &&
    !!event.properties &&
    typeof event.properties === "object" &&
    !Array.isArray(event.properties)
  )
}

function inferBetterC0deTuiPublishType(args: ReadonlyArray<string>): string {
  const positional = betterC0deTuiPublishPositionals(args)
  const explicit = positional.find((arg) => arg.startsWith("tui."))
  if (explicit) return explicit
  if (readBetterC0deTuiPublishOption(args, "command")) {
    return "tui.command.execute"
  }
  if (readBetterC0deTuiPublishOption(args, "text")) {
    return "tui.prompt.append"
  }
  if (
    readBetterC0deTuiPublishOption(args, "sessionID", "session-id", "session")
  ) {
    return "tui.session.select"
  }
  if (
    readBetterC0deTuiPublishOption(args, "message") ||
    readBetterC0deTuiPublishOption(args, "variant")
  ) {
    return "tui.toast.show"
  }
  return ""
}

function parseBetterC0deTuiPublishProperties(
  type: string,
  args: ReadonlyArray<string>
): Record<string, unknown> {
  const positional = betterC0deTuiPublishPositionals(args)
  const afterType =
    positional[0] === type
      ? positional.slice(1)
      : positional.filter((arg) => arg !== type)

  if (type === "tui.command.execute") {
    return {
      command:
        readBetterC0deTuiPublishOption(args, "command", "id", "name") ??
        afterType[0] ??
        "",
    }
  }
  if (type === "tui.prompt.append") {
    return {
      text:
        readBetterC0deTuiPublishOption(args, "text") ??
        afterType.join(" ").trim(),
    }
  }
  if (type === "tui.session.select") {
    return {
      sessionID:
        readBetterC0deTuiPublishOption(
          args,
          "sessionID",
          "session-id",
          "session"
        ) ??
        afterType[0] ??
        "",
    }
  }
  if (type === "tui.toast.show") {
    const duration = readBetterC0deTuiPublishOption(args, "duration")
    return {
      title: readBetterC0deTuiPublishOption(args, "title") ?? "",
      message:
        readBetterC0deTuiPublishOption(args, "message") ??
        afterType.join(" ").trim(),
      variant: readBetterC0deTuiPublishOption(args, "variant") ?? "info",
      ...(duration ? { duration: Number(duration) } : {}),
    }
  }
  return Object.fromEntries(
    afterType.map((value, index) => [`arg${index + 1}`, value])
  )
}

function readBetterC0deTuiPublishOption(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | null {
  const normalizedNames = new Set(names.map((name) => `--${name}`))
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    for (const name of normalizedNames) {
      if (arg === name) return args[index + 1]?.trim() || null
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1).trim() || null
      }
    }
  }
  return null
}

function betterC0deTuiPublishPositionals(
  args: ReadonlyArray<string>
): string[] {
  const valueFlags = new Set([
    "--type",
    "--event",
    "--command",
    "--id",
    "--name",
    "--text",
    "--sessionID",
    "--session-id",
    "--session",
    "--title",
    "--message",
    "--variant",
    "--duration",
  ])
  return args.filter((arg, index) => {
    if (!arg || arg.startsWith("--")) return false
    const previous = args[index - 1]
    return !previous || !valueFlags.has(previous)
  })
}

function validateBetterC0deTuiPublishEvent(
  event: BetterC0deTuiPublishEvent
): string[] {
  const validation: string[] = []
  if (
    ![
      "tui.prompt.append",
      "tui.command.execute",
      "tui.toast.show",
      "tui.session.select",
    ].includes(event.type)
  ) {
    validation.push(
      "Unsupported TUI publish event type. BetterC0de maps `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, and `tui.session.select`."
    )
  }
  if (
    event.type === "tui.command.execute" &&
    typeof event.properties.command !== "string"
  ) {
    validation.push("`tui.command.execute` requires `properties.command`.")
  }
  if (
    event.type === "tui.prompt.append" &&
    typeof event.properties.text !== "string"
  ) {
    validation.push("`tui.prompt.append` requires `properties.text`.")
  }
  if (
    event.type === "tui.session.select" &&
    typeof event.properties.sessionID !== "string"
  ) {
    validation.push("`tui.session.select` requires `properties.sessionID`.")
  }
  if (event.type === "tui.toast.show") {
    if (typeof event.properties.message !== "string") {
      validation.push("`tui.toast.show` requires `properties.message`.")
    }
    if (
      !["info", "success", "warning", "error"].includes(
        String(event.properties.variant ?? "")
      )
    ) {
      validation.push(
        "`tui.toast.show` requires `properties.variant` to be info, success, warning, or error."
      )
    }
  }
  return validation
}

function betterC0deTuiPublishEquivalent(
  event: BetterC0deTuiPublishEvent
): string {
  if (event.type === "tui.command.execute") {
    return betterC0deTuiCommandEquivalent([
      String(event.properties.command ?? ""),
    ])
  }
  if (event.type === "tui.prompt.append") {
    const text = String(event.properties.text ?? "").trim()
    return text
      ? `\`/prompt-paste ${escapeInlineCode(text)}\` or type directly in the composer`
      : "`/prompt-paste <text>` or type directly in the composer"
  }
  if (event.type === "tui.session.select") {
    const sessionId = String(event.properties.sessionID ?? "").trim()
    return sessionId
      ? `\`/resume ${escapeInlineCode(sessionId)}\``
      : "`/sessions`"
  }
  if (event.type === "tui.toast.show") {
    return "the local notification/toast UI"
  }
  return "`/betterc0de-api tui.publish`"
}

export function buildBetterC0deAuthControlOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const route = command.replace(/^\//, "").replace(/-/g, ".")
  const operation = route === "auth.remove" ? "remove" : "set"
  const providerId = resolveAuthControlProviderId(args)
  const equivalent =
    operation === "remove"
      ? "`/providers.logout`, `/auth`, or Settings > Providers"
      : "`/connect`, `/auth`, or Settings > Providers"
  const terminal =
    operation === "remove"
      ? "betterc0de providers logout"
      : "betterc0de providers login --provider <id>"

  return [
    "# BetterC0de Auth Control",
    "",
    `Compatibility reference: \`${route}\` / \`${operation === "remove" ? "DELETE" : "PUT"} /auth/:providerID\`.`,
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Operation | \`${operation}\` |`,
    `| Provider | ${providerId ? `\`${escapeMarkdownTableCell(providerId)}\`` : "_not specified_"} |`,
    `| BetterC0de equivalent | ${equivalent} |`,
    `| Terminal flow | \`${terminal}\` |`,
    "",
    operation === "remove"
      ? "> BetterC0de does not delete provider credentials from this chat route. Use provider settings or the explicit provider logout flow so credential changes stay auditable."
      : "> BetterC0de never accepts raw provider credentials in chat. Use provider settings, OAuth/CLI setup, or the terminal login flow for secrets.",
  ].join("\n")
}

export function buildBetterC0deLifecycleRouteOutput(
  command: string,
  activeThread: ActiveThreadRef
): string {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  const route =
    normalized === "instance.dispose" ? "instance.dispose" : "global.dispose"
  const runtimePath = resolveThreadRuntimePath(activeThread)
  return [
    "# BetterC0de Lifecycle",
    "",
    `Compatibility reference: \`${route}\` / \`POST /${route === "global.dispose" ? "global/dispose" : "instance/dispose"}\`.`,
    "",
    `Scope: **${route === "global.dispose" ? "all BetterC0de compatibility instances" : "current BetterC0de compatibility instance"}**`,
    `Active workspace: ${runtimePath ? `\`${escapeMarkdownTableCell(runtimePath)}\`` : "_none_"}`,
    "",
    "> BetterC0de does not dispose Electron/provider processes from this compatibility route. Use `/exit`, close the app window, restart the selected provider, or stop the active turn explicitly.",
  ].join("\n")
}

export function buildBetterC0deTuiControlRouteOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  const route =
    normalized === "tui.control.response"
      ? "tui.control.response"
      : "tui.control.next"
  const payload = parseBetterC0deTuiControlPayload(args)
  const payloadError = payload.ok ? null : payload.error
  return [
    "# BetterC0de Terminal Control",
    "",
    `Compatibility reference: \`${route}\` / \`${route === "tui.control.next" ? "GET /tui/control/next" : "POST /tui/control/response"}\`.`,
    "",
    route === "tui.control.next"
      ? "Queue status: **BetterC0de has no external TUI request queue pending in chat.**"
      : payload.ok
        ? `Response payload: \`${escapeMarkdownTableCell(JSON.stringify(payload.value))}\``
        : "Response payload: _invalid_",
    payloadError ? "\n## Validation\n" : "",
    payloadError ? `- ${payloadError}` : "",
    "",
    "> These compatibility routes model an external terminal-controller queue. BetterC0de handles the same actions through normal UI controls, slash commands, and `/tui.publish` event mapping.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseBetterC0deTuiControlPayload(
  args: ReadonlyArray<string>
): { ok: true; value: unknown } | { ok: false; value: null; error?: string } {
  const raw = args.join(" ").trim()
  if (!raw) return { ok: true, value: {} }
  if (!raw.startsWith("{")) {
    return {
      ok: false,
      value: null,
      error: "TUI control response payload must be JSON when provided.",
    }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: `Invalid TUI control response JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
    }
  }
}

function resolveAuthControlProviderId(
  args: ReadonlyArray<string>
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--provider" || arg === "--provider-id") {
      return args[index + 1]?.trim() || null
    }
    if (arg.startsWith("--provider=")) {
      return arg.slice("--provider=".length).trim() || null
    }
    if (arg.startsWith("--provider-id=")) {
      return arg.slice("--provider-id=".length).trim() || null
    }
    if (!arg.startsWith("-")) return arg.trim() || null
  }
  return null
}

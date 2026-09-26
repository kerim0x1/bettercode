import type { ProviderKind } from "@betterc0de/schema"

/**
 * The OpenCode-family CLI profile.
 *
 * BetterC0de's own compatibility CLI and the upstream `opencode` binary
 * speak the same agent-facing HTTP/SSE protocol: a v1 surface
 * (`POST /session`, `POST /session/{id}/prompt_async`, `GET /event`,
 * `POST /permission/{id}/reply`, `POST /question/{id}/reply`) and a v2
 * surface (`GET /api/model`, `GET /api/provider`, `GET /api/session/*`).
 * The adapter is one implementation parameterised by which CLI it drives:
 * branding/labels, provider kind, default model hints, the minimum version
 * gate, the server-ready stdout marker, and how the v2 inventory envelopes
 * are shaped.
 *
 * Keeping this in one object (rather than a subclass per CLI) means the
 * protocol translation — permission and question plumbing, tool/part
 * lifecycle, token usage, diff extraction — stays identical for both and is
 * verified once.
 */
export interface OpenCodeCompatProfile {
  /** ProviderKind emitted on every runtime event. */
  readonly providerKind: ProviderKind
  /** `raw.source` stamped onto native SSR/SSE envelopes. */
  readonly rawSource: string
  /** Human-facing product name used in statuses and messages. */
  readonly displayName: string
  /** Prefix for synthesized task ids (`<taskIdPrefix>-compaction:...`). */
  readonly taskIdPrefix: string
  /** Metadata namespace key on `thread.metadata.updated` payloads. */
  readonly metadataNamespace: string
  /** Default binary name on PATH when the instance has no override. */
  readonly defaultBinaryPath: string
  /** Argument that prints the CLI version. */
  readonly versionArgs: ReadonlyArray<string>
  /** Arguments that start the headless server on the given port. */
  readonly serveArgs: (port: number, hostname: string) => ReadonlyArray<string>
  /**
   * Environment variables cleared to an empty config so the CLI starts
   * without a project config leaking permissions into the driven session.
   * Empty for CLIs that do not support a config-content override.
   */
  readonly configContentEnv: ReadonlyArray<string>
  /** Minimum supported CLI semver; `null` disables the version gate. */
  readonly minimumVersion: string | null
  /** Stderr/stdout prefix that marks the headless server as ready. */
  readonly serverReadyPrefixes: ReadonlyArray<string>
  /** Regular expression that extracts the server URL from the ready line. */
  readonly serverReadyUrlPattern: RegExp
  /** Auth header username used when a basic-auth password is configured. */
  readonly serverAuthUsername: string
  /** Environment variable that carries the server password (external mode). */
  readonly serverPasswordEnvVars: ReadonlyArray<string>
  /** Environment variable that carries the server username (external mode). */
  readonly serverUsernameEnvVars: ReadonlyArray<string>
  /**
   * Whether the v2 inventory endpoints wrap their payload in a
   * `{ location, data: [...] }` envelope (current OpenCode) rather than
   * returning a bare array.
   */
  readonly v2Envelope: boolean
  /**
   * Whether the v2 model payload nests api metadata under `api`
   * (`{ id, type, package, url }`) rather than flat `apiID`/`endpoint`
   * fields (current OpenCode).
   */
  readonly v2NestedApi: boolean
}

export const BETTERC0DE_COMPAT_PROFILE: OpenCodeCompatProfile = {
  providerKind: "betterc0de",
  rawSource: "betterc0de.sdk.event",
  displayName: "BetterC0de",
  taskIdPrefix: "betterc0de",
  metadataNamespace: "betterc0de",
  defaultBinaryPath: "betterc0de",
  versionArgs: ["--version"],
  serveArgs: (port, hostname) => [
    "serve",
    `--hostname=${hostname}`,
    `--port=${port}`,
  ],
  configContentEnv: ["BETTERC0DE_CONFIG_CONTENT", "BetterC0de_CONFIG_CONTENT"],
  minimumVersion: "1.14.19",
  serverReadyPrefixes: [
    "betterc0de server listening",
    "BetterC0de server listening",
  ],
  serverReadyUrlPattern: /on\s+(https?:\/\/[^\s]+)/,
  serverAuthUsername: "betterc0de",
  serverPasswordEnvVars: [
    "BETTERC0DE_SERVER_PASSWORD",
    "BetterC0de_SERVER_PASSWORD",
  ],
  serverUsernameEnvVars: [
    "BETTERC0DE_SERVER_USERNAME",
    "BetterC0de_SERVER_USERNAME",
  ],
  v2Envelope: false,
  v2NestedApi: false,
}

export const OPENCODE_CLI_PROFILE: OpenCodeCompatProfile = {
  providerKind: "opencode_cli",
  rawSource: "opencode.sdk.event",
  displayName: "OpenCode",
  taskIdPrefix: "opencode",
  metadataNamespace: "opencode",
  defaultBinaryPath: "opencode",
  versionArgs: ["--version"],
  serveArgs: (port, hostname) => [
    "serve",
    `--hostname=${hostname}`,
    `--port=${port}`,
  ],
  // `opencode serve` has no config-content override; it reads the user's
  // real opencode config, which is the point of driving the CLI.
  configContentEnv: [],
  minimumVersion: null,
  serverReadyPrefixes: ["opencode server listening"],
  serverReadyUrlPattern: /on\s+(https?:\/\/[^\s]+)/,
  serverAuthUsername: "opencode",
  serverPasswordEnvVars: ["OPENCODE_SERVER_PASSWORD"],
  serverUsernameEnvVars: ["OPENCODE_SERVER_USERNAME"],
  v2Envelope: true,
  v2NestedApi: true,
}

export function isOpenCodeFamilyProfile(
  profile: OpenCodeCompatProfile
): boolean {
  return profile.providerKind === "opencode_cli"
}

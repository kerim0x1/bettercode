import {
  BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  BETTERC0DE_KEYBIND_DEFAULTS,
} from "@/lib/betterc0de-keybinds"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  parsePluginConfigObject,
  parsePluginToggleBoolean,
  type ActiveThreadRef,
} from "./provider-config"
import { parseBetterC0dePositiveInteger } from "./runtime-config"

export async function buildProjectTuiConfigWriteOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Terminal UI Config\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectTuiConfigArgs(args)
  if (request.errors.length > 0) {
    return [
      "# BetterC0de Terminal UI Config",
      "",
      "> Could not update the project BetterC0de terminal UI config.",
      "",
      ...request.errors.map((error) => `- ${error}`),
    ].join("\n")
  }
  if (request.settings.length === 0) {
    return [
      "# BetterC0de Terminal UI Config",
      "",
      "> Usage: `/tui --config-only --theme dark --mouse true --diff-style stacked --leader-timeout 2000`",
      "> Keybind usage: `/keybinds --config-only --bind session_export=<leader>x --remove-keybind app_exit`",
      "> Attention usage: `/tui --config-only --attention-enabled true --attention-volume 0.6`",
    ].join("\n")
  }

  const configPath = "tui.json"
  const absoluteConfigPath = resolveWorkspaceFilePath(runtimePath, configPath)
  let config: Record<string, unknown> = {}
  let existed = false
  try {
    const file = await readFile(absoluteConfigPath, { silent404: true })
    existed = true
    config = parsePluginConfigObject(file.content, configPath)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      config = {}
    } else {
      return [
        "# BetterC0de Terminal UI Config",
        "",
        "> Could not read the project TUI config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  normalizeBetterC0deTuiConfigForWrite(config)
  const updateError = applyProjectTuiConfigRequest(config, request)
  if (updateError) {
    return [
      "# BetterC0de Terminal UI Config",
      "",
      "> Could not update the project BetterC0de terminal UI config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${updateError}`,
    ].join("\n")
  }

  try {
    await writeFile(
      runtimePath,
      configPath,
      `${JSON.stringify(config, null, 2)}\n`
    )
  } catch (error) {
    return [
      "# BetterC0de Terminal UI Config",
      "",
      "> Could not write the project TUI config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# BetterC0de Terminal UI Config",
    "",
    existed
      ? "Updated the workspace BetterC0de terminal UI config."
      : "Created the workspace BetterC0de terminal UI config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Settings: ${escapeMarkdownTableCell(formatListPlain(request.settings))}`,
    "",
    "> Config-only mode only edited `tui.json`. BetterC0de UI behavior remains controlled by mapped app settings unless a feature explicitly reads this compatibility config.",
  ].join("\n")
}

interface ProjectTuiConfigRequest {
  theme?: string
  mouse?: boolean
  diffStyle?: "auto" | "stacked"
  leaderTimeout?: number
  scrollSpeed?: number
  scrollAccelerationEnabled?: boolean
  attention: Record<string, unknown>
  keybinds: Record<string, string | null>
  settings: string[]
  errors: string[]
}

const BETTERC0DE_TUI_ATTENTION_SOUND_KEYS = new Set([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])

function parseProjectTuiConfigArgs(
  args: ReadonlyArray<string>
): ProjectTuiConfigRequest {
  const request: ProjectTuiConfigRequest = {
    attention: {},
    keybinds: {},
    settings: [],
    errors: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }

    switch (key) {
      case "--config-only":
        break
      case "--theme": {
        const value = nextValue().trim()
        if (value) {
          request.theme = value
          request.settings.push("theme")
        }
        break
      }
      case "--mouse": {
        const value = parsePluginToggleBoolean(nextOptionalValue() ?? "true")
        if (value === undefined) {
          request.errors.push("`--mouse` must be true or false.")
        } else {
          request.mouse = value
          request.settings.push("mouse")
        }
        break
      }
      case "--diff-style":
      case "--diff_style": {
        const value = nextValue().trim().toLowerCase()
        if (value === "auto" || value === "stacked") {
          request.diffStyle = value
          request.settings.push("diff_style")
        } else {
          request.errors.push("`--diff-style` must be `auto` or `stacked`.")
        }
        break
      }
      case "--leader-timeout":
      case "--leader_timeout": {
        const value = parseBetterC0dePositiveInteger(nextValue())
        if (!value) {
          request.errors.push("`--leader-timeout` must be a positive integer.")
        } else {
          request.leaderTimeout = value
          request.settings.push("leader_timeout")
        }
        break
      }
      case "--scroll-speed":
      case "--scroll_speed": {
        const value = Number(nextValue())
        if (!Number.isFinite(value) || value < 0.001) {
          request.errors.push("`--scroll-speed` must be a number >= 0.001.")
        } else {
          request.scrollSpeed = value
          request.settings.push("scroll_speed")
        }
        break
      }
      case "--scroll-acceleration":
      case "--scroll-acceleration-enabled":
      case "--scroll_acceleration": {
        const value = parsePluginToggleBoolean(nextOptionalValue() ?? "true")
        if (value === undefined) {
          request.errors.push("`--scroll-acceleration` must be true or false.")
        } else {
          request.scrollAccelerationEnabled = value
          request.settings.push("scroll_acceleration.enabled")
        }
        break
      }
      case "--attention-enabled":
      case "--attention-notifications":
      case "--attention-sound": {
        const value = parsePluginToggleBoolean(nextOptionalValue() ?? "true")
        if (value === undefined) {
          request.errors.push(`${key} must be true or false.`)
        } else {
          const attentionKey = key.replace(/^--attention-/, "")
          request.attention[attentionKey] = value
          request.settings.push(`attention.${attentionKey}`)
        }
        break
      }
      case "--attention-volume": {
        const value = Number(nextValue())
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          request.errors.push(
            "`--attention-volume` must be a number between 0 and 1."
          )
        } else {
          request.attention.volume = value
          request.settings.push("attention.volume")
        }
        break
      }
      case "--attention-sound-pack":
      case "--sound-pack": {
        const value = nextValue().trim()
        if (value) {
          request.attention.sound_pack = value
          request.settings.push("attention.sound_pack")
        }
        break
      }
      case "--attention-sound-file":
      case "--sound": {
        addProjectTuiAttentionSound(request, nextValue())
        break
      }
      case "--bind":
      case "--keybind":
      case "--set-keybind": {
        const binding = parseProjectTuiKeybindPair(nextValue(), request.errors)
        if (binding) {
          request.keybinds[binding.key] = binding.value
          request.settings.push(`keybinds.${binding.key}`)
        }
        break
      }
      case "--remove-keybind":
      case "--unset-keybind": {
        const name = normalizeProjectTuiKeybindName(nextValue())
        if (!name) {
          request.errors.push("Unknown BetterC0de keybind name.")
        } else {
          request.keybinds[name] = null
          request.settings.push(`keybinds.${name}`)
        }
        break
      }
      default:
        break
    }
  }

  request.settings = Array.from(new Set(request.settings))
  return request
}

function normalizeBetterC0deTuiConfigForWrite(
  config: Record<string, unknown>
): void {
  if (!("tui" in config)) return
  const nested = config.tui
  delete config.tui
  if (!isPlainObject(nested)) return

  const topLevel = { ...config }
  for (const key of Object.keys(config)) delete config[key]
  Object.assign(config, nested, topLevel)
}

function applyProjectTuiConfigRequest(
  config: Record<string, unknown>,
  request: ProjectTuiConfigRequest
): string | null {
  if (request.theme !== undefined) config.theme = request.theme
  if (request.mouse !== undefined) config.mouse = request.mouse
  if (request.diffStyle !== undefined) config.diff_style = request.diffStyle
  if (request.leaderTimeout !== undefined) {
    config.leader_timeout = request.leaderTimeout
  }
  if (request.scrollSpeed !== undefined)
    config.scroll_speed = request.scrollSpeed
  if (request.scrollAccelerationEnabled !== undefined) {
    const current = config.scroll_acceleration
    if (
      current !== undefined &&
      (!current || typeof current !== "object" || Array.isArray(current))
    ) {
      return "`scroll_acceleration` must be an object."
    }
    config.scroll_acceleration = {
      ...(current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}),
      enabled: request.scrollAccelerationEnabled,
    }
  }
  if (Object.keys(request.attention).length > 0) {
    const current = config.attention
    if (
      current !== undefined &&
      (!current || typeof current !== "object" || Array.isArray(current))
    ) {
      return "`attention` must be an object."
    }
    const nextAttention = {
      ...(current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}),
    }
    for (const [key, value] of Object.entries(request.attention)) {
      if (key === "sounds" && isPlainObject(value)) {
        const currentSounds = nextAttention.sounds
        if (currentSounds !== undefined && !isPlainObject(currentSounds)) {
          return "`attention.sounds` must be an object."
        }
        nextAttention.sounds = {
          ...(isPlainObject(currentSounds) ? currentSounds : {}),
          ...value,
        }
      } else {
        nextAttention[key] = value
      }
    }
    config.attention = nextAttention
  }
  if (Object.keys(request.keybinds).length > 0) {
    const current = config.keybinds
    if (
      current !== undefined &&
      (!current || typeof current !== "object" || Array.isArray(current))
    ) {
      return "`keybinds` must be an object."
    }
    const keybinds =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    for (const [key, value] of Object.entries(request.keybinds)) {
      if (value === null) delete keybinds[key]
      else keybinds[key] = value
    }
    config.keybinds = keybinds
  }
  return null
}

function addProjectTuiAttentionSound(
  request: ProjectTuiConfigRequest,
  value: string
): void {
  const sound = parseProjectTuiAttentionSoundPair(value, request.errors)
  if (!sound) return
  const current = request.attention.sounds
  const sounds = isPlainObject(current) ? { ...current } : {}
  sounds[sound.key] = sound.value
  request.attention.sounds = sounds
  request.settings.push(`attention.sounds.${sound.key}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseProjectTuiAttentionSoundPair(
  value: string,
  errors: string[]
): { key: string; value: string } | null {
  const separator = value.indexOf("=")
  if (separator <= 0) {
    errors.push(
      "Attention sounds must use `name=path`, for example `done=./done.wav`."
    )
    return null
  }
  const rawKey = value.slice(0, separator).trim()
  const key = rawKey.replace(/[.-]/g, "_")
  if (!BETTERC0DE_TUI_ATTENTION_SOUND_KEYS.has(key)) {
    errors.push(
      `Unknown BetterC0de attention sound \`${escapeInlineCode(rawKey)}\`.`
    )
    return null
  }
  const soundPath = value.slice(separator + 1).trim()
  if (!soundPath) {
    errors.push("Attention sound path must not be empty.")
    return null
  }
  return { key, value: soundPath }
}

function parseProjectTuiKeybindPair(
  value: string,
  errors: string[]
): { key: string; value: string } | null {
  const separator = value.indexOf("=")
  if (separator <= 0) {
    errors.push(
      "Keybinds must use `name=binding`, for example `session_export=<leader>x`."
    )
    return null
  }
  const key = normalizeProjectTuiKeybindName(value.slice(0, separator))
  if (!key) {
    errors.push(
      `Unknown BetterC0de keybind \`${escapeInlineCode(value.slice(0, separator).trim())}\`.`
    )
    return null
  }
  const binding = value.slice(separator + 1).trim()
  if (!binding) {
    errors.push("Keybind binding must not be empty.")
    return null
  }
  return { key, value: binding }
}

function normalizeProjectTuiKeybindName(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const normalized = raw.replace(/[.-]/g, "_")
  const match = [
    ...BETTERC0DE_KEYBIND_DEFAULTS,
    ...BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  ].find(
    (item) =>
      item.id === normalized ||
      item.command === raw ||
      item.command.replace(/[.-]/g, "_") === normalized
  )
  return match?.id ?? null
}

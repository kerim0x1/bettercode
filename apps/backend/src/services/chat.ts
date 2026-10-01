import Anthropic from "@anthropic-ai/sdk"
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  modelSelectionSchema,
  type ModelSelection,
} from "@betterc0de/schema"
import OpenAI from "openai"
import { HttpError } from "../errors"
import { logger } from "../observability/logger"
import type { Settings } from "../settings/schema"
import { resolveAnthropicKey, resolveOpenAiKey } from "../auth/keyResolution"
import type { ApiKeyPool } from "../auth/apiKeyPool"
import { deriveProviderInstanceConfigs } from "../provider/runtime/ProviderInstanceManager"
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadContextSummaryPrompt,
  buildThreadTitlePrompt,
  normalizeGeneratedBranchName,
  normalizeGeneratedCommitMessage,
  normalizeGeneratedPrContent,
  normalizeGeneratedThreadContextSummary,
  normalizeGeneratedThreadTitle,
  parseJsonObject,
  sanitizeThreadTitle,
  stripFences,
  stringField,
  type BranchNameGenerationResult,
  type BranchNamePromptInput,
  type CommitMessageGenerationResult,
  type CommitMessagePromptInput,
  type PrContentGenerationResult,
  type PrContentPromptInput,
  type ThreadContextSummaryGenerationResult,
  type ThreadContextSummaryPromptInput,
} from "./text-generation"
import {
  runNativeTextGeneration,
  type NativeTextGenerationSchemaName,
} from "./native-text-generation"
import { getProjectModelDefaults } from "./workspace"

/**
 * LLM-driven helpers for short, throwaway prompts that power the chat UI:
 *   - `generateTitle` produces the 3–6-word thread title shown in the
 *     sidebar. Previously we just sliced the first few words of the first
 *     user message, which produced bad titles like "how do I use".
 *   - `extractQuestions` pulls a structured list of `{text, options[]}`
 *     objects out of an assistant message so the renderer's
 *     `PendingQuestionsPanel` can walk through them.
 *
 * Provider picking: Anthropic first (small model, cheap + fast), OpenAI as
 * second choice, deterministic fallback last so the chat doesn't break on
 * fresh installs with no keys. We explicitly construct the SDK clients here
 * instead of going through `ProviderService` — those flows all stream
 * over the runtime event bus, but for title/question extraction we want a
 * synchronous single-shot response.
 */

/**
 * The helper models are short single-shot calls; without a deadline a stalled
 * provider held a title/commit request open indefinitely.
 */
const HELPER_MODEL_TIMEOUT_MS = 30_000
/** Model ids come from the shared taxonomy, never from literals here. */
const ANTHROPIC_HELPER_MODEL =
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claude ??
  DEFAULT_GIT_TEXT_GENERATION_MODEL
const OPENAI_HELPER_MODEL = DEFAULT_GIT_TEXT_GENERATION_MODEL

// CLI model IDs are deliberately separate from the API-key helper models.
const COMMIT_MESSAGE_CLI_MODELS = {
  codex: "gpt-5.6-luna",
  claude: "claude-sonnet-5",
} as const
const COMMIT_MESSAGE_TIMEOUT_MS = 180_000
const COMMIT_MESSAGE_CLI_TIMEOUT_MS = 90_000

const TEXT_GENERATION_SYSTEM_PROMPT =
  "Follow the prompt exactly. Return ONLY a valid JSON object with the requested keys. Do not include prose or code fences."

const QUESTIONS_SYSTEM_PROMPT =
  "You extract user-facing clarifying questions from an assistant message. " +
  'Return ONLY a JSON array of objects shaped `{"text": string, "options": string[]}` — no prose, no code fences. ' +
  "Each question's `options` is an array of short answer choices the user could pick (0–4 entries, empty if open-ended). " +
  "Skip rhetorical questions, skip questions that are already answered in the surrounding text. " +
  "Return an empty array if there are no real questions."

export interface ChatLlmHelperDeps {
  settings: () => Settings
  apiKeyPool?: ApiKeyPool
}

export class ChatLlmHelpers {
  constructor(private readonly deps: ChatLlmHelperDeps) {}

  async generateTitle(userMessage: string): Promise<string> {
    const trimmed = userMessage.trim()
    if (!trimmed) return "New thread"

    const { prompt } = buildThreadTitlePrompt({ message: trimmed })
    const result = await this.runSingleTurn({
      system: TEXT_GENERATION_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: 64,
    })
    if (result === null) return fallbackTitle(trimmed)
    return normalizeGeneratedThreadTitle(result, {
      fallbackSeed: fallbackTitle(trimmed),
    }).title
  }

  async generateCommitMessage(
    input: CommitMessagePromptInput
  ): Promise<CommitMessageGenerationResult> {
    const { prompt, schemaName } = buildCommitMessagePrompt(input)
    const settings = this.deps.settings()
    const candidates = resolveCommitMessageModelSelections(
      settings,
      input.modelSelection
    )
    if (candidates.length === 0) {
      throw new HttpError(
        422,
        "Enable Codex CLI or Claude CLI in Providers to generate a commit summary. Your draft was kept.",
        "commit_generation_unavailable"
      )
    }

    const deadline = Date.now() + COMMIT_MESSAGE_TIMEOUT_MS
    for (const modelSelection of candidates) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        const result = await runNativeTextGeneration({
          settings,
          cwd: input.cwd,
          modelSelection,
          prompt,
          schemaName,
          timeoutMs: Math.min(COMMIT_MESSAGE_CLI_TIMEOUT_MS, remaining),
        })
        // An empty or incomplete answer should try the next CLI as well.
        return normalizeGeneratedCommitMessage(result, {
          includeBranch: input.includeBranch,
        })
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            providerInstanceId: modelSelection.instanceId,
            model: modelSelection.model,
          },
          "Commit summary CLI failed; trying next candidate"
        )
      }
    }

    throw new HttpError(
      422,
      "Could not generate a commit summary through Codex CLI or Claude CLI. Check the CLI connection in Providers and try again. Your draft was kept.",
      "commit_generation_unavailable"
    )
  }

  async generatePrContent(
    input: PrContentPromptInput
  ): Promise<PrContentGenerationResult> {
    const { prompt, schemaName } = buildPrContentPrompt(input)
    const result = await this.runTextGenerationTurn({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt,
      schemaName,
      system: TEXT_GENERATION_SYSTEM_PROMPT,
      maxTokens: 1200,
    })
    return normalizeGeneratedPrContent(result, {
      fallbackTitleSeed: input.headBranch || input.commitSummary,
    })
  }

  async generateBranchName(
    input: BranchNamePromptInput
  ): Promise<BranchNameGenerationResult> {
    const trimmed = input.message.trim()
    const { prompt, schemaName } = buildBranchNamePrompt(input)
    const result = await this.runTextGenerationTurn({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt,
      schemaName,
      system: TEXT_GENERATION_SYSTEM_PROMPT,
      maxTokens: 96,
    })
    return normalizeGeneratedBranchName(result, {
      fallbackSeed: trimmed || "update",
    })
  }

  async generateThreadContextSummary(
    input: ThreadContextSummaryPromptInput
  ): Promise<ThreadContextSummaryGenerationResult> {
    const { prompt, schemaName } = buildThreadContextSummaryPrompt(input)
    const result = await this.runTextGenerationTurn({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt,
      schemaName,
      system: TEXT_GENERATION_SYSTEM_PROMPT,
      maxTokens: 2400,
      modelSelectionMode: "native-codex-or-claude",
      allowHelperFallback: false,
    })
    if (!result?.trim()) {
      throw new Error(
        "No Codex or Claude CLI compacter is configured or reachable."
      )
    }
    return normalizeGeneratedThreadContextSummary(result, {
      fallbackSummary: "",
    })
  }

  /** A provider handoff must never silently use a different provider/model. */
  async generateProviderHandoffSummary(
    input: ThreadContextSummaryPromptInput & {
      readonly modelSelection: ModelSelection
    }
  ): Promise<ThreadContextSummaryGenerationResult> {
    const { prompt, schemaName } = buildThreadContextSummaryPrompt(input)
    const result = await runNativeTextGeneration({
      settings: this.deps.settings(),
      modelSelection: input.modelSelection,
      prompt:
        prompt +
        "\nThis is a handoff to another provider. Preserve the user's goal, constraints, decisions, changed files, verified results, unresolved failures, and precise next steps. Do not execute tools or continue the task.",
      schemaName,
      // The transcript contains the context; do not grant workspace access.
      cwd: null,
    })
    const summary = normalizeGeneratedThreadContextSummary(result ?? "", {
      fallbackSummary: "",
    }).summary.trim()
    if (!summary)
      throw new Error("The previous provider returned no handoff summary.")
    return { summary }
  }

  /**
   * One-shot skill.md generation for the marketplace "Create Skill" tab.
   * Replaces the retired `anthropic-claude` plugin path (which no-op'd
   * after the plugin's removal) with the shared native text-generation
   * pipeline (Codex/Claude CLI, helper-model fallback).
   */
  async generateSkillContent(input: {
    name: string
    requirements: string
    cwd?: string | null
    modelSelection?: CommitMessagePromptInput["modelSelection"]
  }): Promise<{ content: string }> {
    const prompt = [
      "You are an expert AI skill architect. Write a complete, production-grade",
      "skill.md instruction file (Markdown) that defines how an AI coding agent",
      "should behave when the skill is active. Use this structure: a top-level",
      "title, then sections Purpose, Identity & Tone, Core Rules (numbered),",
      "Capabilities, Limitations, Workflow, Output Format, and Examples.",
      "",
      `Skill name: ${input.name}`,
      "",
      "User requirements:",
      input.requirements,
      "",
      'Respond ONLY with a JSON object of the shape {"content": "<the complete',
      'skill.md file as a Markdown string>"} and nothing else.',
    ].join("\n")
    const result = await this.runTextGenerationTurn({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt,
      schemaName: "skillContent",
      system: TEXT_GENERATION_SYSTEM_PROMPT,
      maxTokens: 4096,
    })
    if (!result?.trim()) {
      throw new Error("Skill generation produced no output.")
    }
    const parsed = parseJsonObject(stripFences(result))
    const content = parsed ? stringField(parsed, "content") : null
    return { content: content?.trim() || result.trim() }
  }

  async extractQuestions(
    assistantText: string
  ): Promise<Array<{ text: string; options: string[] }>> {
    const trimmed = assistantText.trim()
    if (!trimmed) return []

    const raw = await this.runSingleTurn({
      system: QUESTIONS_SYSTEM_PROMPT,
      user: trimmed.slice(0, 8000),
      maxTokens: 512,
    })
    if (raw === null) return fallbackQuestions(trimmed)

    try {
      const parsed = JSON.parse(stripFences(raw))
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(
          (q): q is Record<string, unknown> =>
            typeof q === "object" && q !== null
        )
        .map((q) => ({
          text: typeof q.text === "string" ? q.text.trim() : "",
          options: Array.isArray(q.options)
            ? q.options
                .filter((o): o is string => typeof o === "string")
                .slice(0, 4)
            : [],
        }))
        .filter((q) => q.text.length > 0)
        .slice(0, 8)
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "extractQuestions: model returned non-JSON"
      )
      return fallbackQuestions(trimmed)
    }
  }

  // ────────────────────────────────── private ────────────────────────────

  private async runSingleTurn(args: {
    system: string
    user: string
    maxTokens: number
  }): Promise<string | null> {
    const settings = this.deps.settings()
    const pool = this.deps.apiKeyPool
    const anthropic = resolveAnthropicKey(settings)
    if (
      anthropic &&
      settings.providers.anthropic?.enabled !== false &&
      (!pool || pool.isReady("anthropic"))
    ) {
      try {
        const signal = AbortSignal.timeout(HELPER_MODEL_TIMEOUT_MS)
        const request = (apiKey: string) =>
          new Anthropic({
            apiKey,
            ...(pool
              ? { maxRetries: 0, timeout: HELPER_MODEL_TIMEOUT_MS }
              : {}),
          }).messages.create(
            {
              model: ANTHROPIC_HELPER_MODEL,
              max_tokens: args.maxTokens,
              system: args.system,
              messages: [{ role: "user", content: args.user }],
            },
            { signal }
          )
        const res = pool
          ? await pool
              .snapshot("anthropic")
              .run((key) => request(key.key), signal)
          : await request(anthropic.key)
        const text = res.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("")
        if (text.trim()) return text
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "Anthropic helper failed; trying OpenAI"
        )
      }
    }

    const openai = resolveOpenAiKey(settings)
    if (
      openai &&
      settings.providers.openai?.enabled !== false &&
      (!pool || pool.isReady("openai"))
    ) {
      try {
        const signal = AbortSignal.timeout(HELPER_MODEL_TIMEOUT_MS)
        const request = (apiKey: string) =>
          new OpenAI({
            apiKey,
            ...(pool
              ? { maxRetries: 0, timeout: HELPER_MODEL_TIMEOUT_MS }
              : {}),
          }).chat.completions.create(
            {
              model: OPENAI_HELPER_MODEL,
              // The gpt-5 family rejects `max_tokens` on chat completions.
              max_completion_tokens: args.maxTokens,
              messages: [
                { role: "system", content: args.system },
                { role: "user", content: args.user },
              ],
            },
            { signal }
          )
        const res = pool
          ? await pool.snapshot("openai").run((key) => request(key.key), signal)
          : await request(openai.key)
        const text = res.choices?.[0]?.message?.content ?? ""
        if (text.trim()) return text
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "OpenAI helper failed; using fallback"
        )
      }
    }

    return null
  }

  private async runTextGenerationTurn(args: {
    cwd?: string | null
    modelSelection?: CommitMessagePromptInput["modelSelection"]
    prompt: string
    schemaName: NativeTextGenerationSchemaName
    system: string
    maxTokens: number
    modelSelectionMode?: "any-enabled" | "native-codex-or-claude"
    allowHelperFallback?: boolean
  }): Promise<string | null> {
    const settings = this.deps.settings()
    if (args.modelSelectionMode === "native-codex-or-claude") {
      const modelSelections = resolveThreadContextCompactionModelSelections(
        settings,
        args.modelSelection
      )
      let lastError: Error | null = null

      for (const modelSelection of modelSelections) {
        try {
          const native = await runNativeTextGeneration({
            settings,
            modelSelection,
            prompt: args.prompt,
            schemaName: args.schemaName,
            cwd: args.cwd,
          })
          if (native?.trim()) return native
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          logger.warn(
            {
              err: lastError.message,
              providerInstanceId: modelSelection.instanceId,
              schemaName: args.schemaName,
            },
            "native Codex/Claude compacter failed; trying next candidate"
          )
        }
      }

      if (args.allowHelperFallback === false) {
        if (lastError) throw lastError
        return null
      }
    }

    const modelSelection =
      args.modelSelectionMode === "native-codex-or-claude"
        ? null
        : await resolveTextGenerationModelSelectionForTurn(
            settings,
            args.cwd,
            args.modelSelection
          )

    if (modelSelection) {
      try {
        const native = await runNativeTextGeneration({
          settings,
          modelSelection,
          prompt: args.prompt,
          schemaName: args.schemaName,
          cwd: args.cwd,
        })
        if (native?.trim()) return native
      } catch (err) {
        logger.warn(
          {
            err: (err as Error).message,
            providerInstanceId: modelSelection.instanceId,
            schemaName: args.schemaName,
          },
          args.allowHelperFallback === false
            ? "native text-generation failed"
            : "native text-generation failed; trying helper model"
        )
        if (args.allowHelperFallback === false) throw err
      }
    }

    if (args.allowHelperFallback === false) return null

    return this.runSingleTurn({
      system: args.system,
      user: args.prompt,
      maxTokens: args.maxTokens,
    })
  }
}

export function resolveCommitMessageModelSelections(
  settings: Settings,
  explicit?: ModelSelection | null
): ModelSelection[] {
  const configs = deriveProviderInstanceConfigs(settings)
  // Keep the chosen provider/account, but do not inherit an expensive chat
  // model, stale helper model, or workspace API provider for this small task.
  const preferred =
    explicit?.instanceId ??
    readStoredTextGenerationModelSelection(settings)?.instanceId
  const nativeConfigs = configs.filter(
    (config) =>
      config.enabled !== false &&
      nativeCodexOrClaudeProviderForDriver(config.driver) !== null
  )
  nativeConfigs.sort(
    (a, b) =>
      Number(b.instanceId === preferred) - Number(a.instanceId === preferred)
  )
  return nativeConfigs.map((config) => {
    const provider = nativeCodexOrClaudeProviderForDriver(config.driver)!
    return {
      instanceId: config.instanceId,
      model: COMMIT_MESSAGE_CLI_MODELS[provider],
      options: [
        {
          id: provider === "codex" ? "reasoningEffort" : "effort",
          value: "low",
        },
      ],
    }
  })
}

export function resolveThreadContextCompactionModelSelection(
  settings: Settings,
  explicit?: ModelSelection | null
): ModelSelection | null {
  return (
    resolveThreadContextCompactionModelSelections(settings, explicit)[0] ?? null
  )
}

export function resolveThreadContextCompactionModelSelections(
  settings: Settings,
  explicit?: ModelSelection | null
): ModelSelection[] {
  const configs = deriveProviderInstanceConfigs(settings)
  const candidates: ModelSelection[] = []
  const seen = new Set<string>()
  const pushCandidate = (selection: ModelSelection | null) => {
    const selected = selectNativeCodexOrClaudeModelSelection(configs, selection)
    if (!selected) return
    const key = `${selected.instanceId}\u0000${selected.model}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(selected)
  }

  pushCandidate(normalizeTextGenerationModelSelection(explicit))
  pushCandidate(readStoredTextGenerationModelSelection(settings))

  for (const config of configs) {
    if (
      config.enabled === false ||
      nativeCodexOrClaudeProviderForDriver(config.driver) === null
    ) {
      continue
    }
    pushCandidate({
      instanceId: config.instanceId,
      model: defaultGitTextGenerationModelForDriver(config.driver),
    })
  }

  return candidates
}

export function resolveTextGenerationModelSelection(
  settings: Settings,
  explicit?: ModelSelection | null
): ModelSelection | null {
  const explicitSelection = normalizeTextGenerationModelSelection(explicit)
  if (explicitSelection) return explicitSelection

  const stored = readStoredTextGenerationModelSelection(settings)
  const configs = deriveProviderInstanceConfigs(settings)

  if (stored) {
    const selected = configs.find(
      (config) => config.instanceId === stored.instanceId
    )
    if (selected && selected.enabled !== false) return stored
  }

  const fallback = configs.find((config) => config.enabled !== false)
  if (!fallback) return stored

  return {
    instanceId: fallback.instanceId,
    model: defaultGitTextGenerationModelForDriver(fallback.driver),
  }
}

export async function resolveTextGenerationModelSelectionForTurn(
  settings: Settings,
  cwd?: string | null,
  explicit?: ModelSelection | null
): Promise<ModelSelection | null> {
  const explicitSelection = normalizeTextGenerationModelSelection(explicit)
  if (explicitSelection) return explicitSelection

  const projectSmallModel = await resolveProjectSmallModelSelection(
    settings,
    cwd
  )
  if (projectSmallModel) return projectSmallModel

  return resolveTextGenerationModelSelection(settings, null)
}

async function resolveProjectSmallModelSelection(
  settings: Settings,
  cwd?: string | null
): Promise<ModelSelection | null> {
  const workspace = cwd?.trim()
  if (!workspace) return null

  let smallModel: string | undefined
  try {
    smallModel = (await getProjectModelDefaults(workspace)).smallModel
  } catch {
    return null
  }
  if (!smallModel?.trim()) return null

  const betterc0de = deriveProviderInstanceConfigs(settings).find(
    (config) => config.enabled !== false && isBetterC0deDriver(config.driver)
  )
  if (!betterc0de) return null

  return {
    instanceId: betterc0de.instanceId,
    model: smallModel.trim(),
  }
}

function selectNativeCodexOrClaudeModelSelection(
  configs: ReturnType<typeof deriveProviderInstanceConfigs>,
  selection: ModelSelection | null
): ModelSelection | null {
  if (!selection) return null
  const config = configs.find(
    (item) => item.instanceId === selection.instanceId
  )
  const claudeTerminalHandoff =
    selection.instanceId === "claude-terminal" ||
    (config != null && isClaudeTerminalDriver(config.driver))
  if (!config || config.enabled === false) {
    if (!claudeTerminalHandoff) return null
    const directCompacterConfig = findDirectNativeCompacterConfig(configs)
    if (!directCompacterConfig) return null
    return normalizeThreadContextCompactionSelection(
      directCompacterConfig,
      selection
    )
  }
  const directProvider = nativeCodexOrClaudeProviderForDriver(config.driver)
  if (!directProvider) {
    if (!isClaudeTerminalDriver(config.driver)) return null
    const directCompacterConfig = findDirectNativeCompacterConfig(configs)
    if (!directCompacterConfig) return null
    return normalizeThreadContextCompactionSelection(
      directCompacterConfig,
      selection
    )
  }
  return normalizeThreadContextCompactionSelection(config, selection)
}

function findDirectNativeCompacterConfig(
  configs: ReturnType<typeof deriveProviderInstanceConfigs>
): ReturnType<typeof deriveProviderInstanceConfigs>[number] | null {
  for (const preferredProvider of ["claude", "codex"] as const) {
    const config = configs.find(
      (item) =>
        item.enabled !== false &&
        nativeCodexOrClaudeProviderForDriver(item.driver) === preferredProvider
    )
    if (config) return config
  }
  return null
}

function normalizeThreadContextCompactionSelection(
  config: ReturnType<typeof deriveProviderInstanceConfigs>[number],
  selection: ModelSelection
): ModelSelection {
  const provider = nativeCodexOrClaudeProviderForDriver(config.driver)
  const model = normalizeTextGenerationModelForNativeDriver(
    config.driver,
    selection.model
  )
  const options = provider
    ? normalizeThreadContextCompactionOptions(provider, selection.options)
    : undefined
  return {
    instanceId: config.instanceId,
    model,
    ...(options ? { options } : {}),
  }
}

function normalizeThreadContextCompactionOptions(
  provider: "codex" | "claude",
  options: ModelSelection["options"]
): ModelSelection["options"] | undefined {
  const effort = normalizeTextGenerationEffortForNativeProvider(
    provider,
    readSelectionStringOption(options, "reasoningEffort") ??
      readSelectionStringOption(options, "effort")
  )
  const fastMode = readSelectionBooleanOption(options, "fastMode")
  const normalized: NonNullable<ModelSelection["options"]> = []
  if (effort) {
    normalized.push({
      id: provider === "codex" ? "reasoningEffort" : "effort",
      value: effort,
    })
  }
  if (provider === "codex" && typeof fastMode === "boolean") {
    normalized.push({ id: "fastMode", value: fastMode })
  }
  return normalized.length > 0 ? normalized : undefined
}

function readStoredTextGenerationModelSelection(
  settings: Settings
): ModelSelection | null {
  const rawSettings = settings as unknown as {
    text_generation_model_selection?: ModelSelection | null
    textGenerationModelSelection?: ModelSelection | null
    text_generation_model?: string | null
    textGenerationModel?: string | null
  }
  const selection = normalizeTextGenerationModelSelection(
    rawSettings.text_generation_model_selection ??
      rawSettings.textGenerationModelSelection
  )
  if (selection) return selection

  const legacyModel =
    rawSettings.text_generation_model ?? rawSettings.textGenerationModel
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    return {
      instanceId: "codex",
      model: legacyModel.trim(),
    }
  }

  return null
}

function normalizeTextGenerationModelSelection(
  raw: unknown
): ModelSelection | null {
  const parsed = modelSelectionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function defaultGitTextGenerationModelForDriver(driver: string): string {
  const normalized = driver
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
  const nativeProvider = nativeCodexOrClaudeProviderForDriver(driver)
  const provider =
    nativeProvider ??
    (normalized === "claudeagent" || normalized === "anthropiccli"
      ? "claude"
      : isBetterC0deDriver(driver)
        ? "betterc0de"
        : normalized)
  return Object.hasOwn(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER, provider)
    ? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider]
    : DEFAULT_GIT_TEXT_GENERATION_MODEL
}

function nativeCodexOrClaudeProviderForDriver(
  driver: string
): "codex" | "claude" | null {
  const key = driver
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
  if (key === "codex" || key === "codexcli") return "codex"
  if (
    key === "claude" ||
    key === "claudeagent" ||
    key === "anthropiccli" ||
    key === "claudecli"
  ) {
    return "claude"
  }
  return null
}

function isBetterC0deDriver(driver: string): boolean {
  const key = driver
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
  return (
    key === "betterc0de" ||
    key === "bettercode" ||
    key === "betterc0decli" ||
    key === "bettercodecli" ||
    key === "betterc0deagent" ||
    key === "bettercodeagent"
  )
}

function isClaudeTerminalDriver(driver: string): boolean {
  const key = driver
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
  return (
    key === "claudeterminal" ||
    key === "claudepty" ||
    key === "claudeptywrapper"
  )
}

function normalizeTextGenerationModelForNativeDriver(
  driver: string,
  model: string
): string {
  const provider = nativeCodexOrClaudeProviderForDriver(driver)
  const trimmed = model.trim()
  if (!provider || !trimmed) {
    return defaultGitTextGenerationModelForDriver(driver)
  }
  if (!looksClearlyIncompatibleWithNativeProvider(provider, trimmed)) {
    return trimmed
  }
  return defaultGitTextGenerationModelForDriver(driver)
}

function normalizeTextGenerationEffortForNativeProvider(
  provider: "codex" | "claude",
  raw: string | undefined
): string | null {
  const key = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (!key || key === "off" || key === "none") return null
  if (key === "low" || key === "medium" || key === "high") return key
  if (
    key === "xhigh" ||
    key === "extrahigh" ||
    key === "max" ||
    key === "ultra" ||
    key === "ultrathink" ||
    key === "maxultrathink"
  ) {
    return provider === "codex" ? "xhigh" : "max"
  }
  return null
}

function readSelectionStringOption(
  options: ModelSelection["options"],
  id: string
): string | undefined {
  const value = options?.find((option) => option.id === id)?.value
  return typeof value === "string" ? value : undefined
}

function readSelectionBooleanOption(
  options: ModelSelection["options"],
  id: string
): boolean | undefined {
  const value = options?.find((option) => option.id === id)?.value
  return typeof value === "boolean" ? value : undefined
}

function looksClearlyIncompatibleWithNativeProvider(
  provider: "codex" | "claude",
  model: string
): boolean {
  const key = model.trim().toLowerCase()
  if (provider === "claude") {
    return (
      key === "auto" ||
      key.startsWith("gpt-") ||
      /^o[1345][\w.-]*/.test(key) ||
      key.startsWith("openai/") ||
      key.startsWith("composer-")
    )
  }
  return (
    key === "auto" ||
    key.includes("/") ||
    key.startsWith("claude-") ||
    key.startsWith("anthropic/") ||
    key.startsWith("opus") ||
    key.startsWith("sonnet") ||
    key.startsWith("haiku") ||
    key.startsWith("composer-")
  )
}

/** Deterministic title fallback when no provider is reachable. */
function fallbackTitle(userMessage: string): string {
  const words = userMessage.split(/\s+/).filter(Boolean).slice(0, 8).join(" ")
  return sanitizeGeneratedTitle(words)
}

export function extractGeneratedTitleText(raw: string): string | null {
  const stripped = stripFences(raw)
  const parsed = parseJsonObject(stripped)
  const title = stringField(parsed, "title")
  if (title) return title
  const firstLine = stripped.split(/\r?\n/g)[0]?.trim()
  return firstLine && firstLine.length > 0 ? firstLine : null
}

export function sanitizeGeneratedTitle(raw: string): string {
  return sanitizeThreadTitle(raw.replace(/[.!?]+(?=\s*['"`]*\s*$)/g, ""))
}

/** Deterministic question-extraction fallback — the old regex behaviour. */
function fallbackQuestions(
  text: string
): Array<{ text: string; options: string[] }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith("?") && l.length > 5)
    .slice(0, 5)
    .map((t) => ({ text: t, options: [] as string[] }))
}

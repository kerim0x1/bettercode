import { useState, useCallback, useEffect, useMemo, useRef } from "react"
// Same side-effect rule as monaco-editor-wrapper: ensure monaco workers /
// loader config are installed before the first <Editor> mount.
import "@/lib/monaco-setup"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useTheme } from "@/components/theme-provider"
import { SettingsSection } from "@/components/settings/atoms"
import { BrandMarks } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import {
  canEditCustomRules,
  customRulesDescription,
  listRuntimeMcps,
  listRuntimeSkills,
  listRuntimeSubagents,
  readCustomRules,
  saveCustomRules,
  type CustomRules,
  type RuntimeMcpServer,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import { handleError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useActiveThread } from "@/lib/chat-store"
import {
  getEffectiveRules,
  type WorkspaceEffectiveRuleSource,
  type WorkspaceEffectiveRulesResult,
} from "@/services/backend/workspaceApi"
import {
  CheckIcon,
  CircleAlertIcon,
  FileTextIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react"

const STARTER_RULES = `You are a helpful AI coding assistant. Follow these guidelines:
- Write clean, well-documented code
- Follow the project's existing conventions
- Explain your changes clearly
- Ask clarifying questions when the request is ambiguous`

const EDITOR_OPTIONS_COMMON = {
  fontSize: 13,
  fontFamily:
    "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  lineNumbers: "on" as const,
  wordWrap: "on" as const,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 10, bottom: 10 },
  tabSize: 2,
  insertSpaces: true,
  bracketPairColorization: { enabled: true },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
  },
  smoothScrolling: true,
}

/** The backend's rule scopes in the words Settings uses. */
const RULE_SCOPE_LABEL: Record<WorkspaceEffectiveRuleSource["scope"], string> =
  {
    global: "Global",
    project: "Project",
    directory: "Folder",
    target: "File-specific",
  }

/**
 * The tools that read a rule file, by its name: CLAUDE.md is Claude Code's,
 * AGENTS.md is the shared standard Codex and Cursor read, and .cursorrules
 * and .cursor/rules are Cursor's. Other files get a neutral icon.
 */
function ruleFileBrands(sourcePath: string): readonly string[] {
  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase()
  const name = normalized.split("/").pop() ?? ""
  if (name === "claude.md" || name === "claude.local.md") return ["claude"]
  if (name === "agents.md") return ["codex", "cursor"]
  if (name === ".cursorrules" || normalized.includes(".cursor/rules/")) {
    return ["cursor"]
  }
  return []
}

/** A rule source's name: the user's own rules read as such, files as paths. */
function ruleSourceName(source: WorkspaceEffectiveRuleSource): string {
  if (source.sourceKind === "global-setting") return "Your rules (old setting)"
  const name = source.sourcePath.replace(/\\/g, "/").split("/").pop()
  if (source.scope === "global" && name?.toLowerCase() === "rules.md") {
    return "Your custom instructions (rules.md)"
  }
  return source.sourcePath
}

function RuleSourceIcon({ sourcePath }: { sourcePath: string }) {
  const brands = ruleFileBrands(sourcePath)
  return (
    <span className="mt-px flex h-4 min-w-4 shrink-0 items-center text-muted-foreground">
      {brands.length > 0 ? (
        <BrandMarks ids={brands} />
      ) : (
        <FileTextIcon aria-hidden="true" className="size-3.5" />
      )}
    </span>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SettingsRulesSection() {
  const { theme } = useTheme()
  const confirm = useConfirm()
  const activeThread = useActiveThread()
  // The chat's own checkout, as the backend picks it when it prepares the
  // chat's turns: a ready worktree first, then the project folder.
  const workspacePath = useMemo(
    () =>
      (activeThread?.worktreeState && activeThread.worktreeState !== "ready"
        ? ""
        : activeThread?.worktreePath?.trim()) ||
      activeThread?.projectPath?.trim() ||
      "",
    [
      activeThread?.projectPath,
      activeThread?.worktreePath,
      activeThread?.worktreeState,
    ]
  )
  const [rulesText, setRulesText] = useState("")
  // What rules.md held when it was last read or saved.
  const [savedRulesText, setSavedRulesText] = useState("")
  // rules.md is written by the desktop process; a paired browser on a full
  // session reads it from the backend and shows it read-only.
  const editable = canEditCustomRules()
  const [rulesUnavailable, setRulesUnavailable] =
    useState<CustomRules["unavailable"]>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [showEffectivePreview, setShowEffectivePreview] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState<"save" | "starter" | null>(null)
  const busyRef = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [rulesLoading, setRulesLoading] = useState(true)
  const [targetPath, setTargetPath] = useState(".")
  const [effectiveRules, setEffectiveRules] =
    useState<WorkspaceEffectiveRulesResult | null>(null)
  const [effectiveRulesLoading, setEffectiveRulesLoading] = useState(false)
  const [effectiveRulesError, setEffectiveRulesError] = useState<string | null>(
    null
  )
  const effectiveRulesRequest = useRef(0)
  const rulesRequest = useRef(0)
  const [previewSkills, setPreviewSkills] = useState<RuntimeSkill[]>([])
  const [previewMcps, setPreviewMcps] = useState<RuntimeMcpServer[]>([])
  const [previewSubagents, setPreviewSubagents] = useState<RuntimeSubagent[]>(
    []
  )

  // An unreadable rules.md is not an empty one: saving over it would replace
  // the real file, so the editor stays read-only until a read succeeds.
  const rulesUnreadable = rulesUnavailable === "unreadable"
  const canWrite = editable && loaded && !rulesUnreadable

  const loadRules = useCallback(async () => {
    const requestId = ++rulesRequest.current
    setRulesLoading(true)
    let rules: CustomRules
    try {
      rules = await readCustomRules()
    } catch {
      rules = { content: "", unavailable: "unreadable" }
    }
    if (requestId !== rulesRequest.current) return
    setRulesText(rules.content)
    setSavedRulesText(rules.content)
    setRulesUnavailable(rules.unavailable)
    setLoaded(true)
    setRulesLoading(false)
  }, [])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  // The preview's skills, MCP servers and subagents load on their own, so
  // one failing list never keeps the rules from loading.
  useEffect(() => {
    let active = true
    void Promise.allSettled([
      listRuntimeSkills(),
      listRuntimeMcps(),
      listRuntimeSubagents(),
    ]).then(([skills, mcps, subagents]) => {
      if (!active) return
      setPreviewSkills(skills.status === "fulfilled" ? skills.value : [])
      setPreviewMcps(mcps.status === "fulfilled" ? mcps.value : [])
      setPreviewSubagents(
        subagents.status === "fulfilled" ? subagents.value : []
      )
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    },
    []
  )

  const refreshEffectiveRules = useCallback(
    async (requestedTargetPath: string) => {
      const requestId = ++effectiveRulesRequest.current
      if (!workspacePath) {
        setEffectiveRules(null)
        setEffectiveRulesError(null)
        setEffectiveRulesLoading(false)
        return
      }
      setEffectiveRulesLoading(true)
      setEffectiveRulesError(null)
      try {
        const result = await getEffectiveRules(
          workspacePath,
          requestedTargetPath.trim() || "."
        )
        if (requestId === effectiveRulesRequest.current) {
          setEffectiveRules(result)
        }
      } catch (error) {
        if (requestId === effectiveRulesRequest.current) {
          setEffectiveRules(null)
          setEffectiveRulesError(
            error instanceof Error
              ? error.message
              : "Couldn't work out this project's rules."
          )
        }
      } finally {
        if (requestId === effectiveRulesRequest.current) {
          setEffectiveRulesLoading(false)
        }
      }
    },
    [workspacePath]
  )

  useEffect(() => {
    setTargetPath(".")
    void refreshEffectiveRules(".")
  }, [refreshEffectiveRules])

  const flashSaved = useCallback(() => {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 2000)
  }, [])

  /** Write rules.md; reports a failure and returns false, never throws. */
  const writeRules = useCallback(
    async (content: string, action: "save" | "starter") => {
      if (!canWrite || busyRef.current) return false
      busyRef.current = true
      setBusy(action)
      try {
        await saveCustomRules(content)
      } catch (error) {
        handleError(error, { source: "settings-rules", silent: true })
        toast.error("Couldn't save your rules", {
          description: errorMessage(error),
          id: "settings-rules-save",
        })
        return false
      } finally {
        busyRef.current = false
        setBusy(null)
      }
      setSavedRulesText(content)
      flashSaved()
      void refreshEffectiveRules(targetPath)
      return true
    },
    [canWrite, flashSaved, refreshEffectiveRules, targetPath]
  )

  const handleSave = useCallback(async () => {
    await writeRules(rulesText, "save")
  }, [rulesText, writeRules])

  const handleUseStarterRules = useCallback(async () => {
    if (!canWrite || busyRef.current) return
    if (rulesText.trim() || savedRulesText.trim()) {
      const ok = await confirm({
        title: "Replace your rules with the starter rules?",
        description:
          "This saves the starter rules over rules.md. Your current rules aren't kept.",
        confirmLabel: "Replace rules",
        destructive: true,
      })
      if (!ok) return
    }
    if (await writeRules(STARTER_RULES, "starter")) {
      setRulesText(STARTER_RULES)
    }
  }, [canWrite, confirm, rulesText, savedRulesText, writeRules])

  const previewText = useMemo(
    () =>
      buildSystemInstruction(
        "agent",
        null,
        null,
        null,
        previewSkills
          .filter((skill) => skill.enabled)
          .map((skill) => ({ name: skill.name, content: skill.content })),
        previewMcps
          .filter((mcp) => mcp.enabled)
          .map((mcp) => ({
            name: mcp.name,
            command: mcp.command,
            args: mcp.args,
          })),
        rulesText,
        previewSubagents
          .filter((subagent) => subagent.enabled)
          .map((subagent) => ({
            name: subagent.name,
            description: subagent.description,
            prompt: subagent.prompt,
          }))
      ),
    [previewMcps, previewSkills, previewSubagents, rulesText]
  )

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  const monacoTheme = isDark ? "vs-dark" : "vs"

  const handleSaveRef = useRef(handleSave)
  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSaveRef.current()
    })
  }, [])

  const appliedCount =
    effectiveRules?.sources.filter((source) => source.applied).length ?? 0
  const skippedCount = (effectiveRules?.sources.length ?? 0) - appliedCount

  return (
    <>
      <SettingsSection title="Custom Instructions">
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-pretty text-muted-foreground">
            {customRulesDescription(editable, rulesUnavailable)}
            {editable
              ? " Project files like CLAUDE.md and AGENTS.md are added automatically."
              : null}
          </p>
          {editable && rulesUnreadable ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="flex min-w-0 items-start gap-2">
                <CircleAlertIcon
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0"
                />
                <span className="text-pretty">
                  Couldn&apos;t read your rules file. Nothing was changed.
                </span>
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void loadRules()}
                disabled={rulesLoading}
                aria-busy={rulesLoading}
              >
                {rulesLoading ? (
                  <Loader2Icon
                    aria-hidden="true"
                    className="size-3 motion-safe:animate-spin"
                  />
                ) : (
                  <RefreshCwIcon aria-hidden="true" className="size-3" />
                )}
                Retry
              </Button>
            </div>
          ) : null}
          <div className="relative h-[420px] min-h-[220px] resize-y overflow-hidden rounded-lg border border-border/50 bg-background">
            <div className="absolute top-0 right-0 z-10 flex items-center gap-1.5 rounded-bl-md bg-background/85 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
              <span>
                {canWrite || !loaded ? "rules.md" : "read-only · rules.md"}
              </span>
            </div>
            <Editor
              path="custom-rules.md"
              language="markdown"
              value={rulesText}
              theme={monacoTheme}
              onChange={(val) => {
                if (canWrite) setRulesText(val ?? "")
              }}
              onMount={handleEditorMount}
              options={{
                ...EDITOR_OPTIONS_COMMON,
                readOnly: !canWrite,
                domReadOnly: !editable || rulesUnreadable,
                renderLineHighlight: canWrite ? "line" : "none",
                formatOnPaste: true,
                quickSuggestions: false,
              }}
              loading={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading editor…
                </div>
              }
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {rulesText.length} characters
              {canWrite ? " · Ctrl+S to save" : ""}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {/* A paired browser shows the rules; only the desktop edits them. */}
              {editable ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleUseStarterRules()}
                  disabled={!canWrite || busy !== null}
                  aria-busy={busy === "starter"}
                >
                  {busy === "starter" ? (
                    <Loader2Icon
                      aria-hidden="true"
                      className="size-3 motion-safe:animate-spin"
                    />
                  ) : null}
                  Use starter rules
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                aria-expanded={showPreview}
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? "Hide Preview" : "Preview"}
              </Button>
              {editable ? (
                <Button
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={!canWrite || busy !== null}
                  aria-busy={busy === "save"}
                  className="gap-1.5"
                >
                  {busy === "save" ? (
                    <>
                      <Loader2Icon
                        aria-hidden="true"
                        className="size-3 motion-safe:animate-spin"
                      />
                      Saving…
                    </>
                  ) : saved ? (
                    <>
                      <CheckIcon aria-hidden="true" className="size-3" /> Saved
                    </>
                  ) : (
                    "Save Rules"
                  )}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Effective Workspace Rules"
        description="See which rule files apply to this project, in the order they're combined."
      >
        <div className="space-y-3 px-4 py-3">
          {!workspacePath ? (
            <p className="text-xs text-pretty text-muted-foreground">
              Open a chat in a project to see which rules apply to it.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor="effective-rule-target"
                  className="text-xs font-medium text-foreground"
                >
                  Target path
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="effective-rule-target"
                    value={targetPath}
                    onChange={(event) => setTargetPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void refreshEffectiveRules(targetPath)
                      }
                    }}
                    placeholder="src/components/App.tsx"
                    aria-describedby="effective-rule-target-hint"
                    className="h-10 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void refreshEffectiveRules(targetPath)}
                    disabled={effectiveRulesLoading}
                    aria-busy={effectiveRulesLoading}
                    className="h-10 shrink-0 gap-1.5"
                  >
                    {effectiveRulesLoading ? (
                      <Loader2Icon
                        aria-hidden="true"
                        className="size-3.5 motion-safe:animate-spin"
                      />
                    ) : (
                      <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                    )}
                    Resolve
                  </Button>
                </div>
                <p
                  id="effective-rule-target-hint"
                  className="text-[10px] text-pretty text-muted-foreground"
                >
                  A file or folder in the project; some rules only apply to
                  matching paths.
                </p>
                <p
                  className="truncate text-[10px] text-muted-foreground"
                  title={workspacePath}
                >
                  Workspace: {workspacePath}
                </p>
              </div>

              {effectiveRulesError ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-pretty text-destructive"
                >
                  {effectiveRulesError}
                </div>
              ) : null}

              {effectiveRules ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-pretty text-muted-foreground">
                      {effectiveRules.explanation.summary}
                    </p>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {appliedCount} applied · {skippedCount} skipped
                    </span>
                  </div>

                  {effectiveRules.explanation.precedence.length > 0 ? (
                    <details>
                      <summary className="flex min-h-8 cursor-pointer items-center rounded-sm text-[11px] font-medium text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        How rules are combined
                      </summary>
                      <ol className="mt-1 list-decimal space-y-1 pl-4 text-[11px] text-pretty text-muted-foreground">
                        {effectiveRules.explanation.precedence.map((entry) => (
                          <li key={entry}>{entry}</li>
                        ))}
                      </ol>
                    </details>
                  ) : null}

                  <div className="max-h-[360px] divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/50 bg-background">
                    {effectiveRules.sources.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-pretty text-muted-foreground">
                        No rule files were found for this project.
                      </p>
                    ) : (
                      effectiveRules.sources.map((source) => (
                        <div
                          key={source.id}
                          className="space-y-1.5 px-3 py-2.5"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2.5">
                              <RuleSourceIcon sourcePath={source.sourcePath} />
                              <div className="min-w-0">
                                <p
                                  className="truncate font-mono text-[11px] text-foreground"
                                  title={source.sourcePath}
                                >
                                  {ruleSourceName(source)}
                                </p>
                                <p className="text-[10px] text-muted-foreground tabular-nums">
                                  {RULE_SCOPE_LABEL[source.scope] ??
                                    source.scope}{" "}
                                  · #{source.precedence + 1} in order
                                  {source.scopePath
                                    ? ` · ${source.scopePath}`
                                    : ""}
                                </p>
                              </div>
                            </div>
                            <span
                              className={
                                source.applied
                                  ? "shrink-0 text-[10px] font-medium text-success"
                                  : "shrink-0 text-[10px] font-medium text-muted-foreground"
                              }
                            >
                              {source.applied ? "Applied" : "Skipped"}
                            </span>
                          </div>
                          {source.targetGlobs.length > 0 ? (
                            <p className="font-mono text-[10px] break-all text-muted-foreground">
                              {source.targetGlobs.join(", ")}
                            </p>
                          ) : null}
                          <p className="text-[11px] text-pretty text-muted-foreground">
                            {source.reason}
                          </p>
                          {source.content ? (
                            <details>
                              <summary className="flex min-h-10 cursor-pointer items-center rounded-sm text-[10px] font-medium text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                                Show contents
                                {source.truncated ? " (shortened)" : ""}
                              </summary>
                              <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground">
                                {source.content}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      aria-expanded={showEffectivePreview}
                      onClick={() =>
                        setShowEffectivePreview(!showEffectivePreview)
                      }
                      className="h-10"
                    >
                      {showEffectivePreview
                        ? "Hide combined rules"
                        : "Show combined rules"}
                    </Button>
                  </div>

                  {showEffectivePreview ? (
                    <div className="relative h-[300px] min-h-40 resize-y overflow-hidden rounded-lg border border-border/50 bg-background">
                      <div className="absolute top-0 right-0 z-10 rounded-bl-md bg-background/85 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                        read-only · effective-rules.md
                      </div>
                      <Editor
                        path="effective-rules-preview.md"
                        language="markdown"
                        value={
                          effectiveRules.content ||
                          "(No rules apply to this target)"
                        }
                        theme={monacoTheme}
                        options={{
                          ...EDITOR_OPTIONS_COMMON,
                          readOnly: true,
                          renderLineHighlight: "none",
                          domReadOnly: true,
                        }}
                      />
                    </div>
                  ) : null}
                </>
              ) : effectiveRulesLoading ? (
                <div
                  role="status"
                  className="flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2Icon
                    aria-hidden="true"
                    className="size-3.5 motion-safe:animate-spin"
                  />
                  Resolving workspace rules…
                </div>
              ) : null}
            </>
          )}
        </div>
      </SettingsSection>

      {showPreview && (
        <SettingsSection
          title="Prompt Preview"
          description="Approximate preview — the real prompt also includes project rules and depends on the model you pick."
        >
          <div className="space-y-2 px-4 py-3">
            <div className="relative h-[360px] min-h-[200px] resize-y overflow-hidden rounded-lg border border-border/50 bg-background">
              <div className="absolute top-0 right-0 z-10 flex items-center gap-1.5 rounded-bl-md bg-background/85 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                <span>read-only · approximate</span>
              </div>
              <Editor
                path="system-prompt-preview.md"
                language="markdown"
                value={previewText || "(No custom rules defined)"}
                theme={monacoTheme}
                options={{
                  ...EDITOR_OPTIONS_COMMON,
                  readOnly: true,
                  renderLineHighlight: "none",
                  domReadOnly: true,
                }}
                loading={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading preview…
                  </div>
                }
              />
            </div>
          </div>
        </SettingsSection>
      )}
    </>
  )
}

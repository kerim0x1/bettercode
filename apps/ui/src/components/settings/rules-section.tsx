import { useState, useCallback, useEffect, useMemo, useRef } from "react"
// Same side-effect rule as monaco-editor-wrapper: ensure monaco workers /
// loader config are installed before the first <Editor> mount.
import "@/lib/monaco-setup"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useTheme } from "@/components/theme-provider"
import { SettingsSection } from "@/components/settings/atoms"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import {
  getCustomRules,
  listRuntimeMcps,
  listRuntimeSkills,
  listRuntimeSubagents,
  saveCustomRules,
  type RuntimeMcpServer,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useActiveThread } from "@/lib/chat-store"
import {
  getEffectiveRules,
  type WorkspaceEffectiveRulesResult,
} from "@/services/backend/workspaceApi"
import { CheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"

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

export function SettingsRulesSection() {
  const { theme } = useTheme()
  const activeThread = useActiveThread()
  const workspacePath = useMemo(
    () => activeThread?.projectPath || activeThread?.worktreePath || "",
    [activeThread?.projectPath, activeThread?.worktreePath]
  )
  const [rulesText, setRulesText] = useState("")
  const [showPreview, setShowPreview] = useState(false)
  const [showEffectivePreview, setShowEffectivePreview] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [targetPath, setTargetPath] = useState(".")
  const [effectiveRules, setEffectiveRules] =
    useState<WorkspaceEffectiveRulesResult | null>(null)
  const [effectiveRulesLoading, setEffectiveRulesLoading] = useState(false)
  const [effectiveRulesError, setEffectiveRulesError] = useState<string | null>(
    null
  )
  const effectiveRulesRequest = useRef(0)
  const [previewSkills, setPreviewSkills] = useState<RuntimeSkill[]>([])
  const [previewMcps, setPreviewMcps] = useState<RuntimeMcpServer[]>([])
  const [previewSubagents, setPreviewSubagents] = useState<RuntimeSubagent[]>(
    []
  )

  useEffect(() => {
    Promise.all([
      getCustomRules(),
      listRuntimeSkills(),
      listRuntimeMcps(),
      listRuntimeSubagents(),
    ])
      .then(([rules, skills, mcps, subagents]) => {
        setRulesText(rules)
        setPreviewSkills(skills)
        setPreviewMcps(mcps)
        setPreviewSubagents(subagents)
      })
      .finally(() => setLoaded(true))
  }, [])

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
              : "Unable to resolve workspace rules."
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

  const handleSave = useCallback(async () => {
    await saveCustomRules(rulesText)
    void refreshEffectiveRules(targetPath)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [refreshEffectiveRules, rulesText, targetPath])

  const handleUseStarterRules = useCallback(async () => {
    setRulesText(STARTER_RULES)
    await saveCustomRules(STARTER_RULES)
    void refreshEffectiveRules(targetPath)
  }, [refreshEffectiveRules, targetPath])

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

  return (
    <>
      <SettingsSection title="Custom Instructions">
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Define global instructions stored in backend settings. They merge
            before project, directory, and target rules on each turn.
          </p>
          <div className="relative h-[420px] min-h-[220px] resize-y overflow-hidden rounded-lg border border-border/50 bg-background">
            <div className="absolute top-0 right-0 z-10 flex items-center gap-1.5 rounded-bl-md bg-background/85 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
              <span>settings.custom_rules</span>
            </div>
            <Editor
              path="custom-rules.md"
              language="markdown"
              value={rulesText}
              theme={monacoTheme}
              onChange={(val) => setRulesText(val ?? "")}
              onMount={handleEditorMount}
              options={{
                ...EDITOR_OPTIONS_COMMON,
                readOnly: !loaded,
                renderLineHighlight: "line",
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
            <span className="text-[10px] text-muted-foreground">
              {rulesText.length} characters · Ctrl+S to save
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleUseStarterRules}
              >
                Use starter rules
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? "Hide Preview" : "Preview"}
              </Button>
              <Button size="sm" onClick={handleSave} className="gap-1.5">
                {saved ? (
                  <>
                    <CheckIcon className="size-3" /> Saved
                  </>
                ) : (
                  "Save Rules"
                )}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Effective Workspace Rules"
        description="Inspect the backend-owned merge order for the active workspace and an optional file or directory target."
      >
        <div className="space-y-3 px-4 py-3">
          {!workspacePath ? (
            <p className="text-xs text-pretty text-muted-foreground">
              Open a project-backed conversation to inspect its effective rules.
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
                    className="h-10 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void refreshEffectiveRules(targetPath)}
                    disabled={effectiveRulesLoading}
                    className="h-10 shrink-0 gap-1.5"
                  >
                    {effectiveRulesLoading ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3.5" />
                    )}
                    Resolve
                  </Button>
                </div>
                <p
                  className="truncate text-[10px] text-muted-foreground"
                  title={workspacePath}
                >
                  Workspace: {workspacePath}
                </p>
              </div>

              {effectiveRulesError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-pretty text-destructive">
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
                      {
                        effectiveRules.sources.filter(
                          (source) => source.applied
                        ).length
                      }{" "}
                      applied ·{" "}
                      {
                        effectiveRules.sources.filter(
                          (source) => !source.applied
                        ).length
                      }{" "}
                      skipped
                    </span>
                  </div>

                  <ol className="list-decimal space-y-1 pl-4 text-[11px] text-pretty text-muted-foreground">
                    {effectiveRules.explanation.precedence.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ol>

                  <div className="max-h-[360px] divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/50 bg-background">
                    {effectiveRules.sources.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-pretty text-muted-foreground">
                        No rule sources were found for this workspace.
                      </p>
                    ) : (
                      effectiveRules.sources.map((source) => (
                        <div
                          key={source.id}
                          className="space-y-1.5 px-3 py-2.5"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p
                                className="truncate font-mono text-[11px] text-foreground"
                                title={source.sourcePath}
                              >
                                {source.sourcePath}
                              </p>
                              <p className="text-[10px] text-muted-foreground tabular-nums">
                                {source.scope} · order {source.precedence + 1}
                                {source.scopePath
                                  ? ` · ${source.scopePath}`
                                  : ""}
                              </p>
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
                              <summary className="flex min-h-10 cursor-pointer items-center text-[10px] font-medium text-muted-foreground select-none hover:text-foreground">
                                Inspect source content
                                {source.truncated ? " (truncated)" : ""}
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
                      onClick={() =>
                        setShowEffectivePreview(!showEffectivePreview)
                      }
                      className="h-10"
                    >
                      {showEffectivePreview
                        ? "Hide Merged Context"
                        : "Show Merged Context"}
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
                <div className="flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Resolving workspace rules…
                </div>
              ) : null}
            </>
          )}
        </div>
      </SettingsSection>

      {showPreview && (
        <SettingsSection title="Preview">
          <div className="space-y-2 px-4 py-3">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              System prompt that will be sent to the AI:
            </p>
            <div className="relative h-[360px] min-h-[200px] resize-y overflow-hidden rounded-lg border border-border/50 bg-background">
              <div className="absolute top-0 right-0 z-10 flex items-center gap-1.5 rounded-bl-md bg-background/85 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                <span>read-only · system-prompt.md</span>
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

import { useState, useCallback, useEffect, useId, type ReactNode } from "react"
import { toast } from "sonner"
import { slugifyRuntimeId } from "@/lib/cli-parse"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { BrandMark, BrandMarks } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  canManageRuntimeConfig,
  deleteRuntimeSkill,
  deleteRuntimeSubagent,
  listRuntimeSkills,
  listRuntimeSubagents,
  saveRuntimeSkill,
  saveRuntimeSubagent,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import type { CliPlugin, ScanResult, Skill } from "@/lib/onboarding-store"
import { handleError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  BotIcon,
  EyeOffIcon,
  FolderOpenIcon,
  Loader2Icon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
  WaypointsIcon,
  XIcon,
} from "lucide-react"
import { useActiveThread } from "@/lib/chat-store"
import {
  describeCliScanProjectScope,
  resolveCliScanContext,
} from "@/lib/cli-scan-context"
import { getElectronApi } from "@/services/ipc-facade"

/**
 * A repository's own skills and agents (`project`, and Claude's per-project
 * `local` entries) apply only in that workspace. The desktop import keeps
 * them out of the global stores, so they are neither sent nor counted as
 * imported. Mirrors `isWorkspaceScopedAsset` in the shell's onboarding IPC.
 */
export function isWorkspaceScopedCliAsset(entry: { scope?: unknown }): boolean {
  return entry.scope === "project" || entry.scope === "local"
}

type ScannedSkill = Skill & { scope?: unknown }
type ScannedAgent = (
  | ScanResult["codex"]["agents"][number]
  | ScanResult["claude"]["agents"][number]
) & { scope?: unknown }

/**
 * What Sync from CLI hands the desktop import: user-level skills and agents
 * (Claude Code's and Codex's) not yet in the runtime config, plus the scanned
 * Claude plugins. The import rewrites imported-plugins.json with whatever
 * `plugins` carries, and an omitted field writes an empty list too, so the
 * scan's list is passed rather than an empty one that would erase the
 * record. Items the user removed earlier count as new here: a manual sync
 * brings them back, only the automatic one leaves them out.
 */
export function planCliSkillImport(
  scan: {
    claude?: {
      skills?: ScannedSkill[]
      agents?: ScannedAgent[]
      plugins?: CliPlugin[]
    } | null
    codex?: { skills?: ScannedSkill[]; agents?: ScannedAgent[] } | null
  },
  existing: {
    skillIds: ReadonlySet<string>
    subagentIds: ReadonlySet<string>
  }
): {
  skills: ScannedSkill[]
  agents: ScannedAgent[]
  plugins: CliPlugin[]
  skippedWorkspaceAssets: number
} {
  const foundSkills = [
    ...(scan.claude?.skills ?? []),
    ...(scan.codex?.skills ?? []),
  ]
  const foundAgents = [
    ...(scan.claude?.agents ?? []),
    ...(scan.codex?.agents ?? []),
  ]
  // Only the user's own CLI configuration becomes global; the desktop
  // import drops project-scoped entries, so leave them out here too.
  const userSkills = foundSkills.filter(
    (skill) => !isWorkspaceScopedCliAsset(skill)
  )
  const userAgents = foundAgents.filter(
    (agent) => !isWorkspaceScopedCliAsset(agent)
  )
  return {
    skills: userSkills.filter(
      (skill) =>
        !existing.skillIds.has(slugifyRuntimeId(skill.id || skill.name))
    ),
    agents: userAgents.filter(
      (agent) =>
        !existing.subagentIds.has(slugifyRuntimeId(agent.id || agent.name))
    ),
    plugins: scan.claude?.plugins ?? [],
    skippedWorkspaceAssets:
      foundSkills.length -
      userSkills.length +
      (foundAgents.length - userAgents.length),
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The status line after Sync from CLI, counting only what was imported. */
export function describeCliSkillSync({
  foundSummary,
  importedSkills,
  importedAgents,
  skippedWorkspaceAssets,
}: {
  foundSummary: string
  importedSkills: number
  importedAgents: number
  skippedWorkspaceAssets: number
}): string {
  const imported: string[] = []
  if (importedSkills > 0) imported.push(plural(importedSkills, "skill"))
  if (importedAgents > 0) imported.push(plural(importedAgents, "agent"))
  const parts = [
    foundSummary,
    imported.length > 0
      ? `Imported ${imported.join(" and ")}.`
      : skippedWorkspaceAssets > 0
        ? "Nothing new to import."
        : "All items already imported.",
  ]
  if (skippedWorkspaceAssets > 0) {
    parts.push(
      `Skipped ${plural(skippedWorkspaceAssets, "project item")}: they apply only in their own project.`
    )
  }
  return parts.join(" ")
}

/** What a scan found, by CLI, e.g. "Found 3 skills from Claude Code, 1 agent from Codex." */
export function describeCliSkillScan(scan: {
  claude?: { found?: boolean; skills?: unknown[]; agents?: unknown[] } | null
  codex?: { found?: boolean; skills?: unknown[]; agents?: unknown[] } | null
}): string {
  const parts: string[] = []
  for (const [key, label] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ] as const) {
    const cli = scan[key]
    if (!cli?.found) continue
    parts.push(`${plural(cli.skills?.length ?? 0, "skill")} from ${label}`)
    const agents = cli.agents?.length ?? 0
    if (agents > 0) parts.push(`${plural(agents, "agent")} from ${label}`)
  }
  return parts.length > 0 ? `Found ${parts.join(", ")}.` : ""
}

/**
 * The CLI that loads an imported skill from its own folder (`claude`,
 * `codex`), or null for a skill BetterC0de manages. Turning BetterC0de's
 * record off or deleting it does not change what that CLI loads.
 */
export function cliManagedSkillOwner(
  skill: Pick<RuntimeSkill, "source">
): "claude" | "codex" | null {
  const source = skill.source?.trim().toLowerCase()
  return source === "claude" || source === "codex" ? source : null
}

const CLI_LABEL = { claude: "Claude Code", codex: "Codex" } as const

function cliLabelOf(source: string | undefined): string | null {
  const key = source?.trim().toLowerCase()
  return key === "claude" || key === "codex" ? CLI_LABEL[key] : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EMPTY_SKILL = { name: "", description: "", content: "" }
const EMPTY_SUBAGENT = { name: "", description: "", prompt: "" }

export function SettingsSkillsSection() {
  const activeThread = useActiveThread()
  const activeProjectPath =
    activeThread?.worktreePath ?? activeThread?.projectPath ?? null
  const desktop = canManageRuntimeConfig()
  const confirm = useConfirm()
  const [skills, setSkills] = useState<RuntimeSkill[]>([])
  const [subagents, setSubagents] = useState<RuntimeSubagent[]>([])
  const [loading, setLoading] = useState(desktop)
  const [showSkillForm, setShowSkillForm] = useState(false)
  const [showSubagentForm, setShowSubagentForm] = useState(false)
  const [newSkill, setNewSkill] = useState(EMPTY_SKILL)
  const [newSubagent, setNewSubagent] = useState(EMPTY_SUBAGENT)
  const [skillFormError, setSkillFormError] = useState<string | null>(null)
  const [subagentFormError, setSubagentFormError] = useState<string | null>(
    null
  )
  const [savingForm, setSavingForm] = useState<"skill" | "subagent" | null>(
    null
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextSkills, nextSubagents] = await Promise.all([
        listRuntimeSkills(),
        listRuntimeSubagents(),
      ])
      setSkills(nextSkills)
      setSubagents(nextSubagents)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    refresh().catch(() => setLoading(false))
  }, [desktop, refresh])

  const refreshQuietly = useCallback(
    () =>
      refresh().catch((error) =>
        handleError(error, { source: "settings-skills", silent: true })
      ),
    [refresh]
  )

  const handleAddSkill = useCallback(async () => {
    const name = newSkill.name.trim()
    if (!name || savingForm) return
    const id = slugifyRuntimeId(name)
    if (!id) {
      setSkillFormError("Use letters or numbers in the name.")
      return
    }
    const existing = skills.find((skill) => skill.id === id)
    if (existing) {
      const replace = await confirm({
        title: `Replace ${existing.name}?`,
        description:
          "A skill with this name already exists. Adding this one replaces it.",
        confirmLabel: "Replace",
        destructive: true,
      })
      if (!replace) return
    }
    const description = newSkill.description.trim()
    const content =
      newSkill.content.trim() ||
      `# ${name}\n\n## Description\n${description || "Describe what this skill does."}\n`
    setSavingForm("skill")
    setSkillFormError(null)
    try {
      await saveRuntimeSkill({
        id,
        name,
        description,
        enabled: true,
        isPublic: false,
        content,
      })
    } catch (error) {
      setSkillFormError(`Not saved: ${errorText(error)}`)
      return
    } finally {
      setSavingForm(null)
    }
    toast.success(`Added ${name}`)
    setNewSkill(EMPTY_SKILL)
    setShowSkillForm(false)
    await refreshQuietly()
  }, [confirm, newSkill, refreshQuietly, savingForm, skills])

  const toggleSkill = useCallback(
    async (skill: RuntimeSkill, enabled: boolean) => {
      setBusyId(`skill:${skill.id}`)
      try {
        await saveRuntimeSkill({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          isPublic: skill.public,
          enabled,
          content: skill.content,
          source: skill.source,
          sourceUrl: skill.sourceUrl,
          sourcePath: skill.sourcePath,
          providerKinds: skill.providerKinds,
          providerInstanceIds: skill.providerInstanceIds,
        })
      } catch (error) {
        handleError(error, { source: "settings-skills", silent: true })
        toast.error(
          enabled
            ? `Couldn't turn on ${skill.name}`
            : `Couldn't turn off ${skill.name}`,
          { description: errorText(error) }
        )
      } finally {
        setBusyId(null)
      }
      await refreshQuietly()
    },
    [refreshQuietly]
  )

  /**
   * Delete BetterC0de's record of a skill. For a skill a CLI manages this
   * hides it: the CLI keeps its own copy, and the automatic import does not
   * bring it back (Sync from CLI does).
   */
  const removeSkill = useCallback(
    async (skill: RuntimeSkill, mode: "delete" | "hide") => {
      if (mode === "delete") {
        const ok = await confirm({
          title: `Delete ${skill.name}?`,
          description:
            "The skill is deleted from BetterC0de. This can't be undone.",
          confirmLabel: "Delete",
          destructive: true,
        })
        if (!ok) return
      }
      setBusyId(`skill:${skill.id}`)
      try {
        await deleteRuntimeSkill(skill.id)
      } catch (error) {
        handleError(error, { source: "settings-skills", silent: true })
        toast.error(
          mode === "hide"
            ? `Couldn't hide ${skill.name}`
            : `Couldn't delete ${skill.name}`,
          { description: errorText(error) }
        )
        return
      } finally {
        setBusyId(null)
      }
      if (mode === "hide") {
        const owner = cliManagedSkillOwner(skill)
        toast.success(`Hid ${skill.name}`, {
          description: `${owner ? CLI_LABEL[owner] : "The CLI"} still has it. Sync from CLI brings it back here.`,
        })
      }
      await refreshQuietly()
    },
    [confirm, refreshQuietly]
  )

  const handleAddSubagent = useCallback(async () => {
    const name = newSubagent.name.trim()
    const prompt = newSubagent.prompt.trim()
    if (!name || !prompt || savingForm) return
    const id = slugifyRuntimeId(name)
    if (!id) {
      setSubagentFormError("Use letters or numbers in the name.")
      return
    }
    const existing = subagents.find((subagent) => subagent.id === id)
    if (existing) {
      const replace = await confirm({
        title: `Replace ${existing.name}?`,
        description:
          "A subagent with this name already exists. Adding this one replaces it.",
        confirmLabel: "Replace",
        destructive: true,
      })
      if (!replace) return
    }
    setSavingForm("subagent")
    setSubagentFormError(null)
    try {
      await saveRuntimeSubagent({
        id,
        name,
        description: newSubagent.description.trim(),
        prompt,
        enabled: true,
        source: "local",
      })
    } catch (error) {
      setSubagentFormError(`Not saved: ${errorText(error)}`)
      return
    } finally {
      setSavingForm(null)
    }
    toast.success(`Added ${name}`)
    setNewSubagent(EMPTY_SUBAGENT)
    setShowSubagentForm(false)
    await refreshQuietly()
  }, [confirm, newSubagent, refreshQuietly, savingForm, subagents])

  const toggleSubagent = useCallback(
    async (subagent: RuntimeSubagent, enabled: boolean) => {
      setBusyId(`subagent:${subagent.id}`)
      try {
        await saveRuntimeSubagent({
          id: subagent.id,
          name: subagent.name,
          description: subagent.description,
          prompt: subagent.prompt,
          enabled,
          source: subagent.source,
          sourcePath: subagent.sourcePath,
        })
      } catch (error) {
        handleError(error, { source: "settings-skills", silent: true })
        toast.error(
          enabled
            ? `Couldn't turn on ${subagent.name}`
            : `Couldn't turn off ${subagent.name}`,
          { description: errorText(error) }
        )
      } finally {
        setBusyId(null)
      }
      await refreshQuietly()
    },
    [refreshQuietly]
  )

  const removeSubagent = useCallback(
    async (subagent: RuntimeSubagent) => {
      const from = cliLabelOf(subagent.source)
      const ok = await confirm({
        title: `Delete ${subagent.name}?`,
        description: from
          ? `It stays in ${from}'s own agents folder. BetterC0de won't import it again on its own; Sync from CLI brings it back.`
          : "The subagent is deleted from BetterC0de. This can't be undone.",
        confirmLabel: "Delete",
        destructive: true,
      })
      if (!ok) return
      setBusyId(`subagent:${subagent.id}`)
      try {
        await deleteRuntimeSubagent(subagent.id)
      } catch (error) {
        handleError(error, { source: "settings-skills", silent: true })
        toast.error(`Couldn't delete ${subagent.name}`, {
          description: errorText(error),
        })
        return
      } finally {
        setBusyId(null)
      }
      await refreshQuietly()
    },
    [confirm, refreshQuietly]
  )

  const syncFromCli = useCallback(async () => {
    setSyncing(true)
    setSyncStatus(null)
    try {
      const bridge = getElectronApi()
      if (!bridge?.onboardingScan) {
        setSyncStatus("Only available in the desktop app.")
        return
      }
      const scanContext = await resolveCliScanContext(activeProjectPath)
      const res = (await bridge.onboardingScan(scanContext)) as
        | {
            ok?: boolean
            error?: string
            claude: ScanResult["claude"]
            codex: ScanResult["codex"]
            projectScope?: ScanResult["projectScope"]
          }
        | undefined

      if (!res || res.ok === false) {
        throw new Error(
          res?.error || "Claude Code and Codex couldn't be scanned."
        )
      }

      if (!res.claude?.found && !res.codex?.found) {
        setSyncStatus(
          "Claude Code and Codex aren't installed on this computer."
        )
        return
      }

      const foundSummary =
        `${describeCliSkillScan(res)}${describeCliScanProjectScope(res.projectScope)}`.trim()

      const [currentSkills, currentSubagents] = await Promise.all([
        listRuntimeSkills(),
        listRuntimeSubagents(),
      ])
      const {
        skills: newSkills,
        agents: newAgents,
        plugins,
        skippedWorkspaceAssets,
      } = planCliSkillImport(res, {
        skillIds: new Set(currentSkills.map((s) => s.id)),
        subagentIds: new Set(currentSubagents.map((s) => s.id)),
      })

      if (newSkills.length > 0 || newAgents.length > 0) {
        if (!bridge.onboardingImport) {
          throw new Error("This version of the desktop app can't import.")
        }
        // The desktop process reads each skill's and agent's content from
        // its CLI folder. Nothing is saved without it: a failed import is
        // reported, never replaced by empty copies.
        const importResult = (await bridge.onboardingImport({
          mcpServers: [],
          plugins,
          skills: newSkills,
          agents: newAgents,
        })) as { ok?: boolean; error?: string } | undefined
        if (!importResult?.ok) {
          throw new Error(importResult?.error || "The import failed.")
        }
      }

      await refreshQuietly()
      setSyncStatus(
        describeCliSkillSync({
          foundSummary,
          importedSkills: newSkills.length,
          importedAgents: newAgents.length,
          skippedWorkspaceAssets,
        })
      )
    } catch (err) {
      handleError(err, { source: "settings-skills-sync", silent: true })
      toast.error("Couldn't import from Claude Code and Codex", {
        description: errorText(err),
      })
      await refreshQuietly()
    } finally {
      setSyncing(false)
    }
  }, [activeProjectPath, refreshQuietly])

  const openFolder = useCallback(async (target: string, relative: boolean) => {
    try {
      const bridge = getElectronApi()
      if (!bridge?.openPath)
        throw new Error("Only available in the desktop app.")
      let path = target
      if (relative) {
        const info = await bridge.getAppInfo?.()
        if (!info?.baseDir) throw new Error("BetterC0de's folder is unknown.")
        path = `${info.baseDir.replace(/\\/g, "/")}/${target}`
      }
      await bridge.openPath(path)
    } catch (error) {
      handleError(error, { source: "settings-skills", silent: true })
      toast.error("Couldn't open the folder", {
        description: errorText(error),
      })
    }
  }, [])

  if (!desktop) {
    return (
      <SettingsSection title="Your skills and subagents">
        <SettingsRow
          label="Managed in the BetterC0de desktop app."
          description="Add, change and import skills and subagents on the computer that runs BetterC0de."
          icon={<MonitorIcon />}
        >
          {null}
        </SettingsRow>
      </SettingsSection>
    )
  }

  if (loading) {
    return (
      <SettingsSection title="Your skills and subagents">
        <div
          role="status"
          className="flex items-center justify-center gap-2 px-6 py-8 text-sm text-muted-foreground"
        >
          <Loader2Icon
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Loading skills and subagents…
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      <SettingsSection title="Your skills and subagents">
        <SettingsRow
          label="Used by"
          description="Claude Code and Codex use their own skills folders."
          icon={<WaypointsIcon />}
        >
          <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-muted-foreground">
            <BrandMarks ids={["cursor", "grok-cli"]} />
            <span>API models</span>
          </span>
        </SettingsRow>
        <SettingsRow
          label="Import from Claude Code and Codex"
          description="Adds skills and subagents that aren't here yet, including ones you removed or hid."
          icon={<RefreshCwIcon />}
        >
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
            disabled={syncing}
            aria-busy={syncing || undefined}
            onClick={syncFromCli}
          >
            {syncing ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3.5 motion-safe:animate-spin"
              />
            ) : (
              <BrandMarks ids={["claude", "codex"]} />
            )}
            {syncing ? "Syncing…" : "Sync from CLI"}
          </Button>
        </SettingsRow>
      </SettingsSection>

      {syncStatus ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 px-4 py-3 text-[12.5px] leading-snug text-muted-foreground"
        >
          <p className="min-w-0 flex-1 break-words">{syncStatus}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss the sync summary"
            onClick={() => setSyncStatus(null)}
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <SettingsSection
        title="Skills"
        description="Skills are reusable instructions the AI follows. Add one or import from Claude Code / Codex."
      >
        {skills.length === 0 && !showSkillForm ? (
          <EmptyRow icon={<SparklesIcon />} text="No skills yet." />
        ) : null}
        {skills.map((skill) => {
          const owner = cliManagedSkillOwner(skill)
          const busy = busyId === `skill:${skill.id}`
          if (owner) {
            return (
              <ItemRow
                key={skill.id}
                icon={<BrandMark id={owner} />}
                title={skill.name}
                description={
                  <>
                    {skill.description ? (
                      <span className="block">{skill.description}</span>
                    ) : null}
                    <span className="mt-1 inline-flex items-center gap-1.5 text-[11.5px]">
                      Managed by
                      <BrandMark id={owner} label />
                    </span>
                  </>
                }
                actions={
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-[11px]"
                      aria-label={`Open the ${skill.name} folder`}
                      onClick={() =>
                        skill.sourcePath
                          ? openFolder(skill.sourcePath, false)
                          : openFolder(`skills/${skill.id}`, true)
                      }
                    >
                      <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                      Open folder
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
                      disabled={busy}
                      aria-label={`Hide ${skill.name}`}
                      title={`Hide it here. ${CLI_LABEL[owner]} keeps using it.`}
                      onClick={() => removeSkill(skill, "hide")}
                    >
                      <EyeOffIcon aria-hidden="true" className="size-3.5" />
                      Hide
                    </Button>
                  </>
                }
              />
            )
          }
          return (
            <ItemRow
              key={skill.id}
              icon={<SparklesIcon />}
              title={skill.name}
              description={skill.description || null}
              actions={
                <>
                  <Switch
                    checked={skill.enabled}
                    disabled={busy}
                    aria-label={`Enable ${skill.name}`}
                    onCheckedChange={(value) => toggleSkill(skill, value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Open the ${skill.name} folder`}
                    title="Open folder"
                    className="text-muted-foreground"
                    onClick={() => openFolder(`skills/${skill.id}`, true)}
                  >
                    <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${skill.name}`}
                    title={`Delete ${skill.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() => removeSkill(skill, "delete")}
                  >
                    <Trash2Icon aria-hidden="true" className="size-3.5" />
                  </Button>
                </>
              }
            />
          )
        })}
        {showSkillForm ? (
          <InlineForm
            title="New skill"
            submitLabel="Add skill"
            canSubmit={!!newSkill.name.trim()}
            saving={savingForm === "skill"}
            error={skillFormError}
            onCancel={() => {
              setShowSkillForm(false)
              setSkillFormError(null)
            }}
            onSubmit={handleAddSkill}
            fields={[
              {
                key: "name",
                label: "Name",
                placeholder: "My skill",
                value: newSkill.name,
                onChange: (value) => {
                  setNewSkill((prev) => ({ ...prev, name: value }))
                  setSkillFormError(null)
                },
              },
              {
                key: "description",
                label: "Description",
                placeholder: "What this skill does",
                value: newSkill.description,
                onChange: (value) =>
                  setNewSkill((prev) => ({ ...prev, description: value })),
              },
              {
                key: "content",
                label: "Instructions (Markdown)",
                placeholder:
                  "# My skill\n\n## Description\nExplain when this skill should be applied…",
                value: newSkill.content,
                multiline: true,
                onChange: (value) =>
                  setNewSkill((prev) => ({ ...prev, content: value })),
              },
            ]}
          />
        ) : (
          <AddRow
            label="Add skill"
            onClick={() => {
              setSkillFormError(null)
              setShowSkillForm(true)
            }}
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Subagents"
        description="Subagents are named helper roles the AI can hand work to."
      >
        {subagents.length === 0 && !showSubagentForm ? (
          <EmptyRow icon={<BotIcon />} text="No subagents yet." />
        ) : null}
        {subagents.map((subagent) => {
          const from = cliLabelOf(subagent.source)
          const busy = busyId === `subagent:${subagent.id}`
          const sourceKey = subagent.source?.trim().toLowerCase()
          return (
            <ItemRow
              key={subagent.id}
              icon={<BotIcon />}
              title={subagent.name}
              badge={
                from && sourceKey ? (
                  <Badge
                    variant="outline"
                    className="h-5 gap-1 px-1.5 text-[10.5px] font-normal text-muted-foreground"
                  >
                    <BrandMark id={sourceKey} label />
                  </Badge>
                ) : !subagent.source || sourceKey === "local" ? (
                  <Badge
                    variant="outline"
                    className="h-5 px-1.5 text-[10.5px] font-normal text-muted-foreground"
                  >
                    Local
                  </Badge>
                ) : null
              }
              description={
                subagent.description || subagent.prompt ? (
                  <span className="line-clamp-2">
                    {subagent.description || subagent.prompt}
                  </span>
                ) : null
              }
              actions={
                <>
                  <Switch
                    checked={subagent.enabled}
                    disabled={busy}
                    aria-label={`Enable ${subagent.name}`}
                    onCheckedChange={(value) => toggleSubagent(subagent, value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Open the ${subagent.name} folder`}
                    title="Open folder"
                    className="text-muted-foreground"
                    onClick={() =>
                      from && subagent.sourcePath
                        ? openFolder(subagent.sourcePath, false)
                        : openFolder(`subagents/${subagent.id}`, true)
                    }
                  >
                    <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${subagent.name}`}
                    title={`Delete ${subagent.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() => removeSubagent(subagent)}
                  >
                    <Trash2Icon aria-hidden="true" className="size-3.5" />
                  </Button>
                </>
              }
            />
          )
        })}
        {showSubagentForm ? (
          <InlineForm
            title="New subagent"
            submitLabel="Add subagent"
            canSubmit={!!newSubagent.name.trim() && !!newSubagent.prompt.trim()}
            saving={savingForm === "subagent"}
            error={subagentFormError}
            onCancel={() => {
              setShowSubagentForm(false)
              setSubagentFormError(null)
            }}
            onSubmit={handleAddSubagent}
            fields={[
              {
                key: "name",
                label: "Name",
                placeholder: "Repository analyst",
                value: newSubagent.name,
                onChange: (value) => {
                  setNewSubagent((prev) => ({ ...prev, name: value }))
                  setSubagentFormError(null)
                },
              },
              {
                key: "description",
                label: "Description",
                placeholder: "What this subagent is responsible for",
                value: newSubagent.description,
                onChange: (value) =>
                  setNewSubagent((prev) => ({ ...prev, description: value })),
              },
              {
                key: "prompt",
                label: "Prompt",
                placeholder: "You are a focused subagent. Your scope is…",
                value: newSubagent.prompt,
                multiline: true,
                onChange: (value) =>
                  setNewSubagent((prev) => ({ ...prev, prompt: value })),
              },
            ]}
          />
        ) : (
          <AddRow
            label="Add subagent"
            onClick={() => {
              setSubagentFormError(null)
              setShowSubagentForm(true)
            }}
          />
        )}
      </SettingsSection>
    </>
  )
}

/** A settings row whose title can carry a badge (SettingsRow takes text only). */
function ItemRow({
  icon,
  title,
  badge,
  description,
  actions,
}: {
  icon: ReactNode
  title: string
  badge?: ReactNode
  description?: ReactNode
  actions: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5">
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium break-words">{title}</p>
            {badge}
          </div>
          {description ? (
            <div className="mt-0.5 text-[12.5px] leading-snug break-words text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  )
}

function EmptyRow({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 text-[12.5px] text-muted-foreground">
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center opacity-60 [&_svg]:size-4"
      >
        {icon}
      </span>
      {text}
    </div>
  )
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="px-3 py-2">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground"
        onClick={onClick}
      >
        <PlusIcon aria-hidden="true" className="size-3.5" />
        {label}
      </Button>
    </div>
  )
}

interface InlineField {
  key: string
  label: string
  placeholder: string
  value: string
  multiline?: boolean
  onChange: (value: string) => void
}

function InlineForm({
  title,
  submitLabel,
  canSubmit,
  saving,
  error,
  fields,
  onCancel,
  onSubmit,
}: {
  title: string
  submitLabel: string
  canSubmit: boolean
  saving: boolean
  error: string | null
  fields: InlineField[]
  onCancel: () => void
  onSubmit: () => void
}) {
  const id = useId()
  return (
    <form
      aria-label={title}
      className="space-y-3 bg-muted/20 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit && !saving) onSubmit()
      }}
    >
      <p className="text-[13px] font-semibold">{title}</p>
      {fields.map((field, index) => (
        <div key={field.key} className="space-y-1.5">
          <label
            htmlFor={`${id}-${field.key}`}
            className="text-[11px] font-medium text-muted-foreground"
          >
            {field.label}
          </label>
          {field.multiline ? (
            <Textarea
              id={`${id}-${field.key}`}
              className="min-h-[140px] font-mono text-xs"
              placeholder={field.placeholder}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              rows={8}
            />
          ) : (
            <Input
              id={`${id}-${field.key}`}
              autoFocus={index === 0}
              className="h-8 text-xs"
              placeholder={field.placeholder}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
            />
          )}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || saving}
          aria-busy={saving || undefined}
        >
          {saving ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

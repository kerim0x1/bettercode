import { useCallback, useEffect, useState } from "react"
import {
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { SettingsSection, SettingsRow } from "@/components/settings/atoms"
import { BrandMark } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { useChatStore } from "@/lib/chat-store"
import { useSettingsStore } from "@/lib/settings-store"
import { handleError } from "@/lib/errors"
import { WORKSPACE_TRUST_DESCRIPTION } from "@/lib/workspace-trust-prompts"
import {
  deleteClaudePermissionRule,
  deleteAgentPermissionGrant,
  deleteSessionPermissionRule,
  getAgentWorkspaceTrust,
  listAgentPermissionGrants,
  listClaudePermissionRules,
  listSessionPermissionRules,
  setAgentWorkspaceTrust,
  upsertAgentPermissionGrant,
  type AgentPermissionGrant,
  type WorkspaceTrustRecord,
  type ClaudePermissionRuleEntry,
  type SessionPermissionRuleEntry,
} from "@/services/backend/chatApi"

const SOURCE_LABELS: Record<ClaudePermissionRuleEntry["source"], string> = {
  userSettings: "All projects (~/.claude/settings.json)",
  projectSettings: "Project (.claude/settings.json)",
  localSettings: "Project local (.claude/settings.local.json)",
}

const BEHAVIOR_VARIANTS: Record<
  "allow" | "deny" | "ask",
  "secondary" | "destructive" | "outline"
> = {
  allow: "secondary",
  deny: "destructive",
  ask: "outline",
}

function sessionRuleString(rule: SessionPermissionRuleEntry): string {
  return rule.ruleContent
    ? `${rule.toolName}(${rule.ruleContent})`
    : rule.toolName
}

/**
 * Permissions settings tab: every persisted "Always allow/deny" rule —
 * Claude settings files (written by approval decisions via the CLI) plus
 * BetterC0de's per-thread session mirror — with per-rule delete.
 */
export function SettingsPermissionsSection() {
  const confirm = useConfirm()
  const settings = useSettingsStore()
  const activeProjectPath = useChatStore((state) => {
    const thread = state.threads.find(
      (item) => item.id === state.activeThreadId
    )
    return thread?.projectPath ?? null
  })
  const [claudeRules, setClaudeRules] = useState<ClaudePermissionRuleEntry[]>(
    []
  )
  const [sessionRules, setSessionRules] = useState<
    SessionPermissionRuleEntry[]
  >([])
  const [sharedGrants, setSharedGrants] = useState<AgentPermissionGrant[]>([])
  const [workspaceTrust, setWorkspaceTrust] =
    useState<WorkspaceTrustRecord | null>(null)
  const [grantTool, setGrantTool] = useState("")
  const [grantPath, setGrantPath] = useState(".")
  const [grantBehavior, setGrantBehavior] = useState<"allow" | "ask" | "deny">(
    "ask"
  )
  const [grantDestination, setGrantDestination] = useState<
    "workspace" | "user"
  >(activeProjectPath ? "workspace" : "user")
  const [loading, setLoading] = useState(false)
  // Until the first load finishes, empty lists mean "not read yet".
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [claude, session, shared, trust] = await Promise.all([
        listClaudePermissionRules(activeProjectPath),
        listSessionPermissionRules(null),
        listAgentPermissionGrants(
          activeProjectPath
            ? { workspacePath: activeProjectPath, includeUser: true }
            : { destination: "user" }
        ),
        activeProjectPath
          ? getAgentWorkspaceTrust(activeProjectPath)
          : Promise.resolve(null),
      ])
      setClaudeRules(claude.rules ?? [])
      setSessionRules(session.rules ?? [])
      setSharedGrants(shared.grants ?? [])
      setWorkspaceTrust(trust?.trust ?? null)
    } catch (err) {
      handleError(err, { source: "permission-rules" })
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [activeProjectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeProjectPath && grantDestination === "workspace") {
      setGrantDestination("user")
    }
  }, [activeProjectPath, grantDestination])

  const removeClaudeRule = async (entry: ClaudePermissionRuleEntry) => {
    const ok = await confirm({
      title: "Delete permission rule?",
      description: `${entry.behavior}: ${entry.rule}\n${SOURCE_LABELS[entry.source]}`,
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteClaudePermissionRule({
        source: entry.source,
        behavior: entry.behavior,
        rule: entry.rule,
        cwd: activeProjectPath,
      })
      await refresh()
    } catch (err) {
      handleError(err, { source: "permission-rules" })
    }
  }

  const removeSessionRule = async (entry: SessionPermissionRuleEntry) => {
    const ok = await confirm({
      title: "Delete session rule?",
      description: `${entry.behavior}: ${sessionRuleString(entry)} (thread ${entry.threadId})`,
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteSessionPermissionRule({
        threadId: entry.threadId,
        behavior: entry.behavior,
        rule: sessionRuleString(entry),
      })
      await refresh()
    } catch (err) {
      handleError(err, { source: "permission-rules" })
    }
  }

  const addSharedGrant = async () => {
    const toolName = grantTool.trim()
    const pathScope = grantPath.trim()
    if (!toolName || !pathScope) return
    try {
      await upsertAgentPermissionGrant({
        destination: grantDestination,
        ...(grantDestination === "workspace"
          ? { workspacePath: activeProjectPath }
          : {}),
        toolName,
        pathScope,
        behavior: grantBehavior,
      })
      setGrantTool("")
      setGrantPath(".")
      await refresh()
    } catch (err) {
      handleError(err, { source: "permission-grants" })
    }
  }

  const removeSharedGrant = async (grant: AgentPermissionGrant) => {
    const ok = await confirm({
      title: "Delete shared permission grant?",
      description: `${grant.behavior}: ${grant.toolName} at ${grant.pathScope}`,
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteAgentPermissionGrant(grant.id)
      await refresh()
    } catch (err) {
      handleError(err, { source: "permission-grants" })
    }
  }

  const changeWorkspaceTrust = async () => {
    if (!activeProjectPath || !workspaceTrust) return
    const nextState =
      workspaceTrust.state === "untrusted" || !workspaceTrust.explicit
        ? "trusted"
        : "untrusted"
    const ok = await confirm({
      title:
        nextState === "trusted"
          ? "Trust this workspace?"
          : "Mark this workspace untrusted?",
      description:
        nextState === "trusted"
          ? WORKSPACE_TRUST_DESCRIPTION
          : "Agent Mode and workspace mutations will be blocked for this project until it is trusted again.",
      confirmLabel:
        nextState === "trusted" ? "Trust workspace" : "Mark untrusted",
      destructive: nextState === "untrusted",
    })
    if (!ok) return
    try {
      const result = await setAgentWorkspaceTrust(activeProjectPath, nextState)
      setWorkspaceTrust(result.trust)
    } catch (err) {
      handleError(err, { source: "workspace-trust" })
    }
  }

  const sources: ClaudePermissionRuleEntry["source"][] = [
    "userSettings",
    "projectSettings",
    "localSettings",
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Who can do what: project trust, your own rules, and Claude Code's
          saved approvals.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      </div>

      <SettingsSection
        title="Workspace trust"
        description={
          activeProjectPath
            ? "Trust is scoped to the exact active project root."
            : "Open a project thread to manage its Agent Mode trust."
        }
      >
        <SettingsRow
          label="Trust opened workspaces automatically"
          description="Treat opening a folder as the trust decision, including running the MCP servers, formatters and Claude hooks it declares. Off by default: confirm each project here before Agent Mode runs in it."
        >
          <Switch
            aria-label="Trust opened workspaces automatically"
            checked={settings.autoTrustWorkspaces}
            onCheckedChange={(value) =>
              settings.update({ auto_trust_workspaces: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label={
            workspaceTrust?.state === "untrusted"
              ? "Untrusted workspace"
              : workspaceTrust?.explicit
                ? "Trusted workspace"
                : "Trust not confirmed"
          }
          description={
            workspaceTrust?.state === "untrusted"
              ? "Agent Mode and workspace mutations are blocked."
              : workspaceTrust?.explicit
                ? activeProjectPath
                : settings.autoTrustWorkspaces
                  ? "Will be trusted automatically on the first Agent Mode turn."
                  : "Agent Mode and the project's own MCP servers, formatters and Claude hooks stay off until you trust it."
          }
        >
          {activeProjectPath && workspaceTrust ? (
            <Button
              variant={
                workspaceTrust.state === "untrusted" || !workspaceTrust.explicit
                  ? "default"
                  : "outline"
              }
              size="sm"
              onClick={() => void changeWorkspaceTrust()}
            >
              {workspaceTrust.state === "untrusted" ||
              !workspaceTrust.explicit ? (
                <ShieldCheckIcon className="size-3.5" />
              ) : (
                <ShieldAlertIcon className="size-3.5" />
              )}
              {workspaceTrust.state === "untrusted" || !workspaceTrust.explicit
                ? "Trust project"
                : "Mark untrusted"}
            </Button>
          ) : (
            <span />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Your rules"
        description="Tool and path rules for every provider in Agent Mode. Deny wins over ask, and ask wins over allow."
      >
        <div className="grid gap-2 p-3 sm:grid-cols-2">
          <Input
            value={grantTool}
            onChange={(event) => setGrantTool(event.target.value)}
            placeholder="Tool, e.g. Edit, Write or Bash"
            aria-label="Permission tool name"
          />
          <Input
            value={grantPath}
            onChange={(event) => setGrantPath(event.target.value)}
            placeholder="Path in the project, e.g. src or ."
            aria-label="Permission path scope"
          />
          <Select
            value={grantBehavior}
            onValueChange={(value) =>
              setGrantBehavior(value as "allow" | "ask" | "deny")
            }
          >
            <SelectTrigger className="w-full" aria-label="Permission behavior">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask</SelectItem>
              <SelectItem value="allow">Allow</SelectItem>
              <SelectItem value="deny">Deny</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Select
              value={grantDestination}
              onValueChange={(value) =>
                setGrantDestination(value as "workspace" | "user")
              }
            >
              <SelectTrigger
                className="min-w-0 flex-1"
                aria-label="Permission destination"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace" disabled={!activeProjectPath}>
                  This project
                </SelectItem>
                <SelectItem value="user">All projects</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={
                loading ||
                !grantTool.trim() ||
                !grantPath.trim() ||
                (grantDestination === "workspace" && !activeProjectPath)
              }
              onClick={() => void addSharedGrant()}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
          </div>
        </div>

        {!loaded ? (
          <SettingsRow label="Loading rules…">
            <span />
          </SettingsRow>
        ) : sharedGrants.length === 0 ? (
          <SettingsRow
            label="No rules yet"
            description="Tools follow the permission mode picked in the chat."
          >
            <span />
          </SettingsRow>
        ) : (
          sharedGrants.map((grant) => (
            <SettingsRow
              key={grant.id}
              label={`${grant.toolName} · ${grant.pathScope}`}
              description={
                <span className="inline-flex items-center gap-1.5">
                  <Badge
                    variant={BEHAVIOR_VARIANTS[grant.behavior]}
                    className="text-[10px]"
                  >
                    {grant.behavior}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {grant.destination === "workspace"
                      ? "This project"
                      : "All projects"}
                  </span>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete shared permission ${grant.toolName}`}
                onClick={() => void removeSharedGrant(grant)}
              >
                <Trash2Icon className="size-3.5 text-destructive" />
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsSection>

      {sources.map((source) => {
        const rules = claudeRules.filter((rule) => rule.source === source)
        return (
          <SettingsSection
            key={source}
            icon={<BrandMark id="claude" />}
            title={`Claude Code · ${SOURCE_LABELS[source]}`}
            description={
              source !== "userSettings" && !activeProjectPath
                ? "Open a project chat to see this project's rules."
                : "Saved when you pick “Always allow” or “Always deny” in a Claude Code chat."
            }
          >
            {!loaded ? (
              <SettingsRow label="Loading rules…">
                <span />
              </SettingsRow>
            ) : rules.length === 0 ? (
              <SettingsRow
                label="No rules yet"
                description="Nothing saved here."
              >
                <span />
              </SettingsRow>
            ) : (
              rules.map((rule) => (
                <SettingsRow
                  key={`${rule.source}:${rule.behavior}:${rule.rule}`}
                  label={rule.rule}
                  description={
                    <Badge
                      variant={BEHAVIOR_VARIANTS[rule.behavior]}
                      className="mt-1 text-[10px]"
                    >
                      {rule.behavior}
                    </Badge>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete rule ${rule.rule}`}
                    onClick={() => void removeClaudeRule(rule)}
                  >
                    <Trash2Icon className="size-3.5 text-destructive" />
                  </Button>
                </SettingsRow>
              ))
            )}
          </SettingsSection>
        )
      })}

      <SettingsSection
        title="Session rules"
        description="This session only: “Always allow — this session” decisions, per chat. They end when the chat closes."
      >
        {!loaded ? (
          <SettingsRow label="Loading rules…">
            <span />
          </SettingsRow>
        ) : sessionRules.length === 0 ? (
          <SettingsRow
            label="No session rules"
            description="Nothing active right now."
          >
            <span />
          </SettingsRow>
        ) : (
          sessionRules.map((rule) => (
            <SettingsRow
              key={`${rule.threadId}:${rule.behavior}:${sessionRuleString(rule)}`}
              label={sessionRuleString(rule)}
              description={
                <span className="inline-flex items-center gap-1.5">
                  <Badge
                    variant={BEHAVIOR_VARIANTS[rule.behavior]}
                    className="text-[10px]"
                  >
                    {rule.behavior}
                  </Badge>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {rule.threadId}
                  </span>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete session rule ${sessionRuleString(rule)}`}
                onClick={() => void removeSessionRule(rule)}
              >
                <Trash2Icon className="size-3.5 text-destructive" />
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsSection>
    </div>
  )
}

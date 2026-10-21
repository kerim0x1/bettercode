import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { useChatStore } from "@/lib/chat-store"
import { createThreadWorktree } from "@/services/backend/coreApi"
import { sendChatMessage } from "@/lib/chat/send-message"
import {
  usePreferencesStore,
  type PermissionLevel,
} from "@/lib/preferences-store"

// ── Agent Names & Colors ──

const AGENT_NAMES = [
  "Atlas",
  "Nova",
  "Echo",
  "Cipher",
  "Pulse",
  "Vertex",
  "Prism",
  "Nexus",
  "Flux",
  "Helix",
  "Orbit",
  "Sage",
  "Blaze",
  "Drift",
  "Quartz",
]

const AGENT_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#14b8a6",
  "#6366f1",
]

// ── Types ──

export type MultiAgentSessionStatus =
  | "configuring"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"

export type AgentStatus = "idle" | "working" | "waiting" | "done" | "error"

export interface AgentConfig {
  id: string
  name: string
  modelId: string
  providerId: string
  role: string
  threadId: string | null
  worktreePath?: string | null
  branch?: string | null
  baseBranch?: string | null
  status: AgentStatus
  turnsCompleted: number
  lastOutput: string | null
  color: string
}

export interface BulletinEntry {
  agentId: string
  agentName: string
  turnNumber: number
  summary: string
  timestamp: string
}

export interface MultiAgentSession {
  id: string
  task: string
  status: MultiAgentSessionStatus
  agents: AgentConfig[]
  bulletin: BulletinEntry[]
  maxTurnsPerAgent: number
  createdAt: string
  completedAt?: string
  projectPath: string
  projectName: string
  /**
   * Permission level snapshot at session start. Frozen so all sub-agent
   * turns in this run use the same policy even if the user toggles the
   * composer preference mid-run. Undefined on legacy persisted sessions
   * (migrated in at start).
   */
  permissionLevel?: PermissionLevel
}

// ── Resolve provider (mirrors App.tsx resolveProviderTarget, simplified) ──

type _ProviderInfo = {
  id: string
  providerKind?: string
  openaiTransport?: string
}

type ProviderResolveTarget = {
  providerKind: string
  openaiTransport: string | null
  providerInstanceId?: string | null
}

// ── Store ──

interface MultiAgentState {
  session: MultiAgentSession | null
  isConfigOpen: boolean

  // Config
  openConfig: () => void
  closeConfig: () => void
  setTask: (task: string) => void
  addAgent: (modelId: string, providerId: string, role?: string) => void
  removeAgent: (agentId: string) => void
  updateAgentModel: (
    agentId: string,
    modelId: string,
    providerId: string
  ) => void
  updateAgentRole: (agentId: string, role: string) => void
  setMaxTurns: (n: number) => void

  // Execution
  startSession: (
    resolveProvider: (
      providerId: string,
      modelId: string
    ) => Promise<ProviderResolveTarget>,
    buildInstruction: (mode: string) => string
  ) => Promise<void>
  pauseSession: () => void
  resumeSession: (
    resolveProvider: (
      providerId: string,
      modelId: string
    ) => Promise<ProviderResolveTarget>,
    buildInstruction: (mode: string) => string
  ) => void
  cancelSession: () => void

  // Orchestration
  handleAgentTurnComplete: (
    threadId: string,
    resolveProvider: (
      providerId: string,
      modelId: string
    ) => Promise<ProviderResolveTarget>,
    buildInstruction: (mode: string) => string
  ) => void
  updateAgentStatus: (agentId: string, status: AgentStatus) => void

  // Cleanup
  clearSession: () => void
}

function pickName(usedNames: string[]): string {
  const available = AGENT_NAMES.filter((n) => !usedNames.includes(n))
  if (available.length > 0)
    return available[Math.floor(Math.random() * available.length)]
  return `Agent-${Math.floor(Math.random() * 9000 + 1000)}`
}

function buildAgentSystemPrompt(
  agent: AgentConfig,
  allAgents: AgentConfig[],
  bulletin: BulletinEntry[],
  task: string,
  isFirstTurn: boolean
): string {
  const othersList = allAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => `- **${a.name}**${a.role ? ` — ${a.role}` : ""}`)
    .join("\n")

  const bulletinText =
    bulletin.length > 0
      ? bulletin
          .map((b) => `**${b.agentName}** (Turn ${b.turnNumber}): ${b.summary}`)
          .join("\n\n")
      : ""

  const firstTurnInstructions = `This is the FIRST turn. You MUST:
1. Greet the team by name and state your specialty.
2. Claim a concrete ownership lane: files, modules, risks, or investigation scope you will handle.
3. Suggest any non-overlapping lanes your teammates should own based on their names/roles.
4. Start useful work immediately when ownership is clear: inspect relevant files, run safe read-only checks, or implement a small low-risk slice in your lane.
5. If you edit files, stay inside your lane, list the files touched, and do not revert teammate or user changes.
6. Ask teammates only for real blockers or overlap decisions.

Write like a teammate, but optimize for concrete progress. Do not spend the whole turn on ceremony.`

  const laterTurnInstructions = `Read what your teammates said below. Then:
1. Address teammates BY NAME when responding to their specific findings or work.
2. Continue your owned work lane unless a teammate found a blocker or overlap.
3. Review teammate work when it intersects your lane; call out bugs, conflicts, or missing tests.
4. Make concrete progress every turn: inspect, edit, run a check, or produce a specific decision.
5. Report exact files changed, commands run, verification results, and remaining blockers.
6. Coordinate next steps only where it prevents duplicate work.

Be direct and practical. Do not merely summarize the bulletin — move the task forward.`

  return `You are **${agent.name}**, part of a team of ${allAgents.length} AI agents collaborating in a group chat.
${agent.role ? `Your specialty: ${agent.role}.` : ""}
${agent.worktreePath ? `You are working in your own isolated git worktree: ${agent.worktreePath}${agent.branch ? ` on branch ${agent.branch}` : ""}. Your teammates have separate worktrees, so coordinate before asking anyone to copy changes back to the main workspace.` : ""}

## Your Teammates
${othersList || "None"}

## How This Works
- You are in a live group chat with your teammates. Everything you write is visible to all of them.
- You are also an autonomous coding worker. Use available tools when the task requires codebase inspection, edits, tests, or verification.
- After you respond, your teammates will see your message and respond to it.
- You are NOT working alone. Claim a lane, avoid overlap, review related teammate work, and adapt to what they changed.
- If a teammate made a mistake or you see a better approach, speak up politely but clearly.
- Always review what teammates have done before duplicating work or editing shared files.

## Rules
- ALWAYS address at least one teammate by name in your response.
- NEVER ignore what teammates said — read and respond to their messages.
- Be specific: "I'll implement the auth middleware in apps/api/auth.ts" not "I'll help with the backend".
- Make useful progress in your lane every turn unless blocked.
- Do not revert user or teammate changes. If a file has unrelated edits, work around them and mention the constraint.
- Challenge bad ideas constructively. Praise good ones.
- If you're the first to respond on a subtask, claim it: "I'm taking ownership of X."

${isFirstTurn ? firstTurnInstructions : laterTurnInstructions}

${bulletinText ? `## Chat History (what your teammates said)\n${bulletinText}` : ""}

## The Task
${task}`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + "..."
}

export const useMultiAgentStore = create<MultiAgentState>()(
  persist(
    (set, get) => ({
      session: null,
      isConfigOpen: false,

      openConfig: () => {
        const session = get().session
        if (!session) {
          // Create a new blank session
          set({
            isConfigOpen: true,
            session: {
              id: crypto.randomUUID(),
              task: "",
              status: "configuring",
              agents: [],
              bulletin: [],
              maxTurnsPerAgent: 10,
              createdAt: new Date().toISOString(),
              projectPath: "",
              projectName: "",
            },
          })
        } else {
          set({ isConfigOpen: true })
        }
      },

      closeConfig: () => set({ isConfigOpen: false }),

      setTask: (task) => {
        const session = get().session
        if (!session) return
        set({ session: { ...session, task } })
      },

      addAgent: (modelId, providerId, role = "") => {
        const session = get().session
        if (!session || session.agents.length >= 10) return
        const usedNames = session.agents.map((a) => a.name)
        const idx = session.agents.length
        set({
          session: {
            ...session,
            agents: [
              ...session.agents,
              {
                id: crypto.randomUUID(),
                name: pickName(usedNames),
                modelId,
                providerId,
                role,
                threadId: null,
                status: "idle",
                turnsCompleted: 0,
                lastOutput: null,
                color: AGENT_COLORS[idx % AGENT_COLORS.length],
              },
            ],
          },
        })
      },

      removeAgent: (agentId) => {
        const session = get().session
        if (!session) return
        set({
          session: {
            ...session,
            agents: session.agents.filter((a) => a.id !== agentId),
          },
        })
      },

      updateAgentModel: (agentId, modelId, providerId) => {
        const session = get().session
        if (!session) return
        set({
          session: {
            ...session,
            agents: session.agents.map((a) =>
              a.id === agentId ? { ...a, modelId, providerId } : a
            ),
          },
        })
      },

      updateAgentRole: (agentId, role) => {
        const session = get().session
        if (!session) return
        set({
          session: {
            ...session,
            agents: session.agents.map((a) =>
              a.id === agentId ? { ...a, role } : a
            ),
          },
        })
      },

      setMaxTurns: (n) => {
        const session = get().session
        if (!session) return
        set({
          session: {
            ...session,
            maxTurnsPerAgent: Math.max(1, Math.min(20, n)),
          },
        })
      },

      startSession: async (resolveProvider, _buildInstruction) => {
        const session = get().session
        if (!session || session.agents.length === 0 || !session.task.trim())
          return

        const chatStore = useChatStore.getState()

        // Determine project from the active thread
        const activeThread = chatStore.threads.find(
          (t) => t.id === chatStore.activeThreadId
        )
        const projectPath = activeThread?.projectPath || ""
        const projectName = activeThread?.projectName || "Project"

        // Create threads for each agent (without changing activeThreadId)
        const preparedAgents = session.agents.map((agent) => {
          const title = `[Swarm:${session.id}] ${agent.name}`
          // createThread sets activeThreadId — we'll restore it after
          const threadId = chatStore.createThread(
            title,
            projectName,
            projectPath
          )
          return { ...agent, threadId, status: "working" as AgentStatus }
        })

        // Restore activeThreadId to what it was before
        if (activeThread) {
          chatStore.setActiveThread(activeThread.id)
        }

        // Freeze the composer's current permission level onto the session so
        // every sub-agent turn in this run honors the user's choice at start
        // time — avoids races when parallel agents read a mid-run toggle.
        const frozenPermission: PermissionLevel =
          usePreferencesStore.getState().permissionLevel

        let updatedSession: MultiAgentSession = {
          ...session,
          agents: preparedAgents,
          status: "running",
          projectPath,
          projectName,
          permissionLevel: frozenPermission,
        }
        set({ session: updatedSession, isConfigOpen: false })

        const updatedAgents = await Promise.all(
          preparedAgents.map(async (agent) => {
            if (!agent.threadId) return agent
            if (!projectPath) {
              markAgentErrored(
                agent.id,
                agent.name,
                0,
                new Error(
                  "Open a git-backed workspace before starting Multiagent."
                )
              )
              return { ...agent, status: "error" as AgentStatus }
            }
            try {
              const worktree = await createThreadWorktree(agent.threadId, {
                baseRepoPath: projectPath,
                firstMessage: `${session.task}\n\n${agent.role}`.trim(),
              })
              chatStore.updateThreadContext(agent.threadId, {
                envMode: "worktree",
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                baseBranch: worktree.baseBranch,
                worktreeState: "ready",
              })
              return {
                ...agent,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                baseBranch: worktree.baseBranch,
              }
            } catch (err) {
              markAgentErrored(agent.id, agent.name, 0, err)
              return { ...agent, status: "error" as AgentStatus }
            }
          })
        )

        const hasRunnableAgents = updatedAgents.some(
          (agent) => agent.status !== "error"
        )
        const latestBulletin =
          get().session?.bulletin ?? updatedSession.bulletin
        updatedSession = {
          ...updatedSession,
          agents: updatedAgents,
          bulletin: latestBulletin,
          status: hasRunnableAgents ? "running" : "completed",
          ...(hasRunnableAgents
            ? {}
            : { completedAt: new Date().toISOString() }),
        }
        set({ session: updatedSession })
        if (!hasRunnableAgents) return

        // Send initial messages in parallel
        const sends = updatedAgents.map(async (agent) => {
          if (!agent.threadId || agent.status === "error") return
          const prompt = buildAgentSystemPrompt(
            agent,
            updatedAgents,
            [],
            session.task,
            true
          )

          const dispatchUserMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: prompt,
            modelId: agent.modelId,
            createdAt: new Date().toISOString(),
          } as const
          chatStore.addMessage(agent.threadId, dispatchUserMessage)
          chatStore.setStreamingModelId(agent.threadId, agent.modelId)
          chatStore.appendStreamDelta(agent.threadId, "")

          try {
            const target = await resolveProvider(
              agent.providerId,
              agent.modelId
            )
            await sendChatMessage(
              agent.threadId,
              prompt,
              agent.modelId,
              target.providerKind,
              null, // reasoningEffort
              "agent", // chatMode
              agent.worktreePath || null,
              null, // specialMode
              frozenPermission, // permissionLevel (frozen at session start)
              target.openaiTransport,
              null,
              target.providerInstanceId ?? null,
              null,
              null,
              dispatchUserMessage
            )
          } catch (err) {
            chatStore.clearStreaming(agent.threadId)
            // Surface the failure in the bulletin so the user sees it, not just
            // a grey "error" badge. Users had no diagnostic before this change.
            markAgentErrored(agent.id, agent.name, 1, err)
          }
        })

        await Promise.all(sends)
      },

      pauseSession: () => {
        const session = get().session
        if (!session || session.status !== "running") return
        set({
          session: {
            ...session,
            status: "paused",
            agents: session.agents.map((a) =>
              a.status === "working" || a.status === "waiting"
                ? { ...a, status: "waiting" }
                : a
            ),
          },
        })
      },

      resumeSession: (resolveProvider, _buildInstruction) => {
        const session = get().session
        if (!session || session.status !== "paused") return

        const waitingAgents = session.agents.filter(
          (a) => a.status === "waiting"
        )
        set({
          session: {
            ...session,
            status: "running",
            agents: session.agents.map((a) =>
              a.status === "waiting" ? { ...a, status: "working" } : a
            ),
          },
        })

        // Re-send follow-ups for waiting agents
        for (const agent of waitingAgents) {
          if (
            !agent.threadId ||
            agent.turnsCompleted >= session.maxTurnsPerAgent
          )
            continue
          sendFollowUp(agent, get().session!, resolveProvider)
        }
      },

      cancelSession: () => {
        const session = get().session
        if (!session) return
        // Interrupt all streaming threads
        const chatStore = useChatStore.getState()
        for (const agent of session.agents) {
          if (agent.threadId && agent.status === "working") {
            chatStore.clearStreaming(agent.threadId)
          }
        }
        set({
          session: {
            ...session,
            status: "cancelled",
            agents: session.agents.map((a) => ({
              ...a,
              status: a.status === "done" ? "done" : "idle",
            })),
          },
        })
      },

      handleAgentTurnComplete: (
        threadId,
        resolveProvider,
        _buildInstruction
      ) => {
        const session = get().session
        if (!session || session.status !== "running") return

        const agent = session.agents.find((a) => a.threadId === threadId)
        if (!agent) return

        // Get latest assistant message
        const chatStore = useChatStore.getState()
        const thread = chatStore.threads.find((t) => t.id === threadId)
        const lastAssistant = [...(thread?.messages || [])]
          .reverse()
          .find((m) => m.role === "assistant")
        const output = lastAssistant?.content || ""
        const summary = truncate(output, 2000)

        // Update bulletin
        const newEntry: BulletinEntry = {
          agentId: agent.id,
          agentName: agent.name,
          turnNumber: agent.turnsCompleted + 1,
          summary,
          timestamp: new Date().toISOString(),
        }

        const newTurns = agent.turnsCompleted + 1
        const isDone = newTurns >= session.maxTurnsPerAgent

        const updatedAgents = session.agents.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                turnsCompleted: newTurns,
                lastOutput: summary,
                status: isDone
                  ? ("done" as AgentStatus)
                  : ("waiting" as AgentStatus),
              }
            : a
        )
        const updatedBulletin = [...session.bulletin, newEntry]
        // Keep bulletin manageable (last 30 entries)
        const trimmedBulletin = updatedBulletin.slice(-30)

        const updatedSession: MultiAgentSession = {
          ...session,
          agents: updatedAgents,
          bulletin: trimmedBulletin,
        }

        // Check if all agents are done
        const allDone = updatedAgents.every(
          (a) => a.status === "done" || a.status === "error"
        )
        if (allDone) {
          set({
            session: {
              ...updatedSession,
              status: "completed",
              completedAt: new Date().toISOString(),
            },
          })
          return
        }

        set({ session: updatedSession })

        // Send follow-ups to all active agents (including this one if not done)
        for (const a of updatedAgents) {
          if (a.status === "waiting" && a.threadId) {
            sendFollowUp(
              a,
              { ...updatedSession, bulletin: trimmedBulletin },
              resolveProvider
            )
            // Mark as working
            set((state) => {
              if (!state.session) return state
              return {
                session: {
                  ...state.session,
                  agents: state.session.agents.map((ag) =>
                    ag.id === a.id ? { ...ag, status: "working" } : ag
                  ),
                },
              }
            })
          }
        }
      },

      updateAgentStatus: (agentId, status) => {
        const session = get().session
        if (!session) return
        set({
          session: {
            ...session,
            agents: session.agents.map((a) =>
              a.id === agentId ? { ...a, status } : a
            ),
          },
        })
      },

      clearSession: () => set({ session: null, isConfigOpen: false }),
    }),
    {
      name: "betterc0de.multi-agent.v1",
      storage: createJSONStorage(() => localStorage),
      // Persist only the session (not the transient config-open flag). Status is
      // coerced to "paused" on rehydrate so stale "running" state doesn't leave
      // agents looking active when no streams are actually attached.
      partialize: (state) => ({ session: state.session }),
      onRehydrateStorage: () => (state) => {
        if (!state?.session) return
        if (state.session.status === "running") {
          state.session = { ...state.session, status: "paused" }
        }
      },
    }
  )
)

// ── Helper: Send follow-up message to an agent ──

const FOLLOW_UP_BACKOFFS_MS = [0, 1000, 2000] // original + 2 retries

function markAgentErrored(
  agentId: string,
  agentName: string,
  turnNumber: number,
  err: unknown
) {
  const message =
    err instanceof Error ? err.message : String(err || "unknown error")
  useMultiAgentStore.setState((state) => {
    if (!state.session) return state
    const bulletin = [
      ...state.session.bulletin,
      {
        agentId,
        agentName,
        turnNumber,
        summary: `[ERROR] ${agentName} could not respond: ${message}`,
        timestamp: new Date().toISOString(),
      },
    ].slice(-30)
    return {
      session: {
        ...state.session,
        agents: state.session.agents.map((a) =>
          a.id === agentId ? { ...a, status: "error" as AgentStatus } : a
        ),
        bulletin,
      },
    }
  })
}

async function sendFollowUp(
  agent: AgentConfig,
  session: MultiAgentSession,
  resolveProvider: (
    providerId: string,
    modelId: string
  ) => Promise<ProviderResolveTarget>
) {
  if (!agent.threadId) return
  const threadId = agent.threadId
  const chatStore = useChatStore.getState()

  try {
    // Build the recent chat messages from other agents
    const recentEntries = session.bulletin.slice(-10)
    const chatLog = recentEntries
      .map((b) => `**${b.agentName}**: ${b.summary}`)
      .join("\n\n---\n\n")

    const otherAgents = session.agents
      .filter((a) => a.id !== agent.id)
      .map((a) => a.name)
      .join(", ")

    const followUp = `## Group Chat — New Messages from Your Teammates

${chatLog}

---

**Your turn, ${agent.name}.** Your teammates (${otherAgents}) have shared their thoughts above.

Respond to them directly:
- Address them BY NAME — react to what they said.
- If they proposed a plan, confirm or challenge it based on your ownership lane.
- If they shared code/work, REVIEW it when it intersects your lane — check for bugs, conflicts, or missing tests.
- Take a concrete next step now: inspect, edit, run a check, or document a specific decision.
- Share YOUR progress, exact files touched, commands run, verification results, and blockers.
- If you see overlapping work, coordinate: "Hey @X, I noticed you're also working on Y — should I take Z instead?"
- Be a real teammate. Don't just summarize — discuss, debate, build, and verify together.`

    const dispatchUserMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: followUp,
      modelId: agent.modelId,
      createdAt: new Date().toISOString(),
    } as const
    chatStore.addMessage(threadId, dispatchUserMessage)
    chatStore.setStreamingModelId(threadId, agent.modelId)
    chatStore.appendStreamDelta(threadId, "")

    // Exponential backoff. Stop retrying if the session is paused/cancelled/etc.
    let lastError: unknown = null
    for (let attempt = 0; attempt < FOLLOW_UP_BACKOFFS_MS.length; attempt++) {
      const current = useMultiAgentStore.getState().session
      if (!current || current.status !== "running") return
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, FOLLOW_UP_BACKOFFS_MS[attempt]))
      }
      try {
        const target = await resolveProvider(agent.providerId, agent.modelId)
        await sendChatMessage(
          threadId,
          followUp,
          agent.modelId,
          target.providerKind,
          null,
          "agent",
          agent.worktreePath || null,
          null,
          session.permissionLevel ?? "allow-edits",
          target.openaiTransport,
          null,
          target.providerInstanceId ?? null,
          null,
          null,
          dispatchUserMessage
        )
        return // success
      } catch (err) {
        lastError = err
      }
    }

    chatStore.clearStreaming(threadId)
    markAgentErrored(agent.id, agent.name, agent.turnsCompleted + 1, lastError)
  } catch (err) {
    // Defensive: swallow any synchronous failure so it never becomes an
    // unhandled rejection when this function is fired without await.
    chatStore.clearStreaming(threadId)
    markAgentErrored(agent.id, agent.name, agent.turnsCompleted + 1, err)
  }
}

import { describe, expect, it } from "vitest"
import type { DesignBrief, DesignDefaults } from "@betterc0de/schema/design"
import { DESIGN_STYLE_TEMPLATES } from "@betterc0de/schema/design"
import {
  BASE_IDENTITY,
  buildSystemInstruction,
  MODE_INSTRUCTIONS,
} from "./mode-instructions"

const DESIGN_BRIEF_FIXTURE: DesignBrief = {
  target: "website",
  colorMode: "mixed",
  styleTemplateId: "minimal-saas",
  customStyleReferences: {
    websiteLinks: ["https://example.com"],
    imageFiles: [],
    htmlFiles: [],
    notes: "Use the same spacing discipline.",
  },
  fontPresetId: "geist",
  customFont: "",
  componentImports: [
    {
      libraryId: "core",
      componentId: "button",
      name: "Button",
    },
  ],
  description: "Create a premium agency landing page.",
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
}

function buildDesignPrompt(
  brief: DesignBrief | null = DESIGN_BRIEF_FIXTURE,
  options?: {
    specialMode?: string | null
    designDefaults?: DesignDefaults | null
    mode?: string
  }
) {
  return buildSystemInstruction(
    options?.mode ?? "plan",
    options?.specialMode ?? null,
    "read-only",
    null,
    [],
    [],
    null,
    [],
    null,
    "design",
    brief,
    options?.designDefaults
  )
}

describe("plan mode instructions", () => {
  it("uses explore-first planning instead of mandatory question loops", () => {
    const plan = MODE_INSTRUCTIONS.plan

    expect(plan).toContain("Ground in the environment first")
    expect(plan).toContain(
      "Do not ask questions that can be answered from the repo"
    )
    expect(plan).toContain(
      "Do not ask filler questions just because Plan Mode is active"
    )
    expect(plan).toContain("<proposed_plan>")
    expect(plan).not.toContain("ask 3–6 clarifying questions")
    expect(plan).not.toContain("mandatory before planning")
  })
})

describe("retired modes", () => {
  it("no longer treats Security or Debug as a mode", () => {
    // Both were removed from the composer. A thread stored in one of them
    // must fall back to Agent rather than keep applying instructions for a
    // mode the user can no longer see or leave.
    for (const retired of ["security", "debug"]) {
      const prompt = buildSystemInstruction(retired, null, "bypass")
      expect(prompt, retired).not.toContain("# Mode: Security")
      expect(prompt, retired).not.toContain("# Mode: Debug")
    }
  })

  it("keeps the Security Audit special focus, which is a different feature", () => {
    const prompt = buildSystemInstruction("agent", "security", "bypass")
    expect(prompt).toContain("# Special Focus: Security Audit")
  })
})

describe("ask mode instructions", () => {
  it("matches the read/search/question tool allowlist", () => {
    const ask = MODE_INSTRUCTIONS.ask

    expect(ask).toContain("WebSearch")
    expect(ask).toContain("WebFetch")
    expect(ask).toContain("AskUserQuestion")
    expect(ask).toContain("Do NOT use Write, Edit, or Bash tools")
  })
})

describe("canvas mode instructions", () => {
  it("injects the design brief without removing plan mode restrictions", () => {
    const prompt = buildDesignPrompt()

    expect(prompt).toContain("# Mode: Plan")
    expect(prompt).toContain("You are operating inside BetterC0de Canvas Mode")
    expect(prompt).toContain("Target: Website")
    expect(prompt).toContain("Visual mode: Mixed light and dark sections")
    expect(prompt).toContain("Component imports: Button (core/button)")
    expect(prompt).toContain("MUST NOT write, create, delete")
  })

  it("injects core craft rules, hard bans, and the verification loop", () => {
    const prompt = buildDesignPrompt()

    expect(prompt).toContain("## Design-First Workflow")
    expect(prompt).toContain("## Hard Bans")
    expect(prompt).toContain("## Verification Loop")
    expect(prompt).toContain("prefers-reduced-motion")
  })

  it("injects only the selected target and color-mode blocks", () => {
    const prompt = buildDesignPrompt()

    expect(prompt).toContain("## Target: Website")
    expect(prompt).toContain("## Color Mode: Mixed")
    expect(prompt).not.toContain("## Target: Dashboard")
    expect(prompt).not.toContain("## Color Mode: Dark")
  })

  it("embeds the selected template's rich prompt but no other template", () => {
    const prompt = buildDesignPrompt()

    expect(prompt).toContain("reference class: Linear, Vercel, Stripe")
    // Only minimal-saas is selected — premium-dark-agency's art direction
    // must not leak into the overlay.
    expect(prompt).not.toContain("high-end creative studio")
  })

  it("prefers a user-customized template prompt over the builtin", () => {
    const custom: DesignDefaults = {
      styleTemplates: [
        {
          id: "minimal-saas",
          name: "Minimal SaaS",
          description: "House style.",
          direction: "Our own direction.",
          prompt: "HOUSE STYLE: strictly follow the ACME design tokens.",
        },
      ],
      fontPresets: [],
      componentLibraries: [],
    }
    const prompt = buildDesignPrompt(DESIGN_BRIEF_FIXTURE, {
      designDefaults: custom,
    })

    expect(prompt).toContain(
      "HOUSE STYLE: strictly follow the ACME design tokens."
    )
    expect(prompt).not.toContain("reference class: Linear, Vercel, Stripe")
  })

  it("backfills the builtin prompt for stale persisted snapshots", () => {
    const builtin = DESIGN_STYLE_TEMPLATES.find((t) => t.id === "minimal-saas")!
    // Simulates settings persisted before the `prompt` field existed: the
    // entry matches the builtin but has no prompt.
    const stale: DesignDefaults = {
      styleTemplates: [
        {
          id: builtin.id,
          name: builtin.name,
          description: builtin.description,
          direction: builtin.direction,
          prompt: "",
        },
      ],
      fontPresets: [],
      componentLibraries: [],
    }
    const prompt = buildDesignPrompt(DESIGN_BRIEF_FIXTURE, {
      designDefaults: stale,
    })

    expect(prompt).toContain("reference class: Linear, Vercel, Stripe")
  })

  it("keeps a deliberately customized direction instead of backfilling", () => {
    const edited: DesignDefaults = {
      styleTemplates: [
        {
          id: "minimal-saas",
          name: "Minimal SaaS",
          description: "House style.",
          direction: "Deliberately different direction.",
          prompt: "",
        },
      ],
      fontPresets: [],
      componentLibraries: [],
    }
    const prompt = buildDesignPrompt(DESIGN_BRIEF_FIXTURE, {
      designDefaults: edited,
    })

    expect(prompt).toContain("Deliberately different direction.")
    expect(prompt).not.toContain("reference class: Linear, Vercel, Stripe")
  })

  it("supersedes the frontend special-mode overlay while design is active", () => {
    const prompt = buildDesignPrompt(DESIGN_BRIEF_FIXTURE, {
      specialMode: "frontend",
    })

    expect(prompt).toContain("You are operating inside BetterC0de Canvas Mode")
    expect(prompt).not.toContain("# Special Focus: Frontend & UI/UX")
  })

  it("still stacks orthogonal special modes on top of design", () => {
    const prompt = buildDesignPrompt(DESIGN_BRIEF_FIXTURE, {
      specialMode: "performance",
    })

    expect(prompt).toContain("# Special Focus: Performance Optimization")
  })

  it("keeps the frontend overlay when canvas mode is inactive", () => {
    const prompt = buildSystemInstruction("agent", "frontend", "bypass")

    expect(prompt).toContain("# Special Focus: Frontend & UI/UX")
  })

  it("falls back to asking for missing brief details when no brief exists", () => {
    const prompt = buildDesignPrompt(null)

    expect(prompt).toContain("No completed Design Brief is attached")
    expect(prompt).toContain("ask only for the missing design-critical details")
    expect(prompt).not.toContain("## Target:")
  })

  it("renders reference material as actionable study instructions", () => {
    const prompt = buildDesignPrompt()

    expect(prompt).toContain("### Reference material — study BEFORE designing")
    expect(prompt).toContain("https://example.com")
    expect(prompt).toContain(
      "Client notes (treat as binding constraints): Use the same spacing discipline."
    )
  })
})

describe("subagent prompt context", () => {
  it("includes BetterC0de project agent metadata and scoped permissions", () => {
    const prompt = buildSystemInstruction(
      "agent",
      null,
      "ask-on-edit",
      null,
      [],
      [],
      null,
      [
        {
          name: "Reviewer",
          description: "Review code before merge",
          mode: "subagent",
          model: "anthropic/claude-sonnet-4-6",
          sourcePath: ".betterc0de/agent/reviewer.md",
          tools: { read: true, write: false },
          permissions: [
            {
              permission: "edit",
              pattern: "*",
              action: "deny",
              sourcePath: ".betterc0de/agent/reviewer.md#tools.write",
            },
          ],
          prompt: "Review carefully.",
        },
      ]
    )

    expect(prompt).toContain("## Available Subagents")
    expect(prompt).toContain("### Reviewer")
    expect(prompt).toContain("Mode: subagent")
    expect(prompt).toContain("Model: anthropic/claude-sonnet-4-6")
    expect(prompt).toContain("Tools: read: enabled, write: disabled")
    expect(prompt).toContain("Permissions: edit:*=deny")
  })
})

describe("MCP prompt context", () => {
  it("permits only BetterC0de-resolved CLI imports", () => {
    expect(BASE_IDENTITY).toContain(
      "Use only MCP tools and skills that BetterC0de explicitly resolved"
    )
    expect(BASE_IDENTITY).not.toContain(
      "Do not use MCP servers or skills from CLI directories"
    )
  })

  it("does not advertise configured servers as executable tools", () => {
    const prompt = buildSystemInstruction(
      "agent",
      null,
      "ask-on-edit",
      null,
      [],
      [{ name: "Docs", command: "docs-mcp", args: ["--stdio"] }]
    )

    expect(prompt).toContain("## Configured MCP Servers")
    expect(prompt).toContain(
      "unless that tool is present in your active tool list"
    )
    expect(prompt).not.toContain("installed and available")
  })

  it("renders server names only, never command lines, arguments or URLs", () => {
    const prompt = buildSystemInstruction(
      "agent",
      null,
      "ask-on-edit",
      null,
      [],
      [
        {
          name: "Database",
          command: "pg-mcp",
          args: ["postgresql://user:hunter2@db.internal/app", "--api-key=sk-1"],
        },
        { name: "Remote", url: "https://mcp.example.test/?token=secret" },
        { name: "Remote", url: "https://duplicate.example.test" },
        { name: "Multi\nline `name`", command: "x" },
      ]
    )

    expect(prompt).toContain("- **Database**\n")
    expect(prompt).toContain("- **Remote**\n")
    expect(prompt.match(/- \*\*Remote\*\*/g)).toHaveLength(1)
    expect(prompt).toContain("- **Multi line name**\n")
    expect(prompt).not.toContain("pg-mcp")
    expect(prompt).not.toContain("hunter2")
    expect(prompt).not.toContain("sk-1")
    expect(prompt).not.toContain("mcp.example.test")
    expect(prompt).not.toContain("token=secret")
  })
})

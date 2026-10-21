export interface PlanStep {
  id: string
  text: string
  done: boolean
}

export interface PlanSection {
  name: string
  steps: PlanStep[]
}

export interface ParsedPlan {
  title: string
  description: string
  sections: PlanSection[]
  links: { text: string; href: string }[]
  previewContent: string
  rawContent: string
}

type JsonRecord = Record<string, unknown>

const PLAN_TYPE_VALUES = new Set([
  "betterc0de.plan",
  "betterc0de_plan",
  "betterc0de-plan",
])

const PROPOSED_PLAN_BLOCK_REGEX =
  /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i

export function extractProposedPlanMarkdown(text: string): string | null {
  const match = text.match(PROPOSED_PLAN_BLOCK_REGEX)
  const planMarkdown = match?.[1]?.trim()
  return planMarkdown ? planMarkdown : null
}

// `stripProposedPlanWrapper` returns just the plan body, dropping any model
// preamble and the `<proposed_plan>` wrapper, tolerant of an unclosed
// opening tag; unlike `extractProposedPlanMarkdown` it never returns null.
// It is shared with the phone app, so both show a plan the same way.
export { stripProposedPlanWrapper } from "@betterc0de/schema/pending-requests"

export function wrapProposedPlanMarkdown(planMarkdown: string): string {
  const existing = extractProposedPlanMarkdown(planMarkdown)
  if (existing) return planMarkdown
  return `<proposed_plan>\n${planMarkdown.trim()}\n</proposed_plan>`
}

export function unwrapPlanContent(text: string): string {
  return extractProposedPlanMarkdown(text) ?? text
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readString(record: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function normalizeStatus(raw: unknown): string {
  return typeof raw === "string"
    ? raw
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : ""
}

function isDoneStatus(raw: unknown): boolean {
  const status = normalizeStatus(raw)
  return (
    status === "done" ||
    status === "complete" ||
    status === "completed" ||
    status === "success" ||
    status === "succeeded"
  )
}

function normalizePlanStep(
  value: unknown,
  fallbackId: string
): (PlanStep & { section?: string }) | null {
  if (typeof value === "string") {
    const text = value.trim()
    return text ? { id: fallbackId, text, done: false } : null
  }
  if (!isRecord(value)) return null

  const text = readString(value, [
    "text",
    "step",
    "task",
    "title",
    "description",
    "action",
  ])
  if (!text) return null

  const id = readString(value, ["id", "key", "slug"]) || fallbackId
  const done =
    typeof value.done === "boolean"
      ? value.done
      : typeof value.completed === "boolean"
        ? value.completed
        : isDoneStatus(value.status)
  const section = readString(value, ["section", "phase", "group"])

  return {
    id,
    text,
    done,
    ...(section ? { section } : {}),
  }
}

function pushSection(sections: PlanSection[], name: string, steps: PlanStep[]) {
  const cleanName = name.trim() || "Tasks"
  const cleanSteps = steps.filter((step) => step.text.trim())
  if (cleanSteps.length === 0) return
  sections.push({ name: cleanName, steps: cleanSteps })
}

function normalizeStepArray(
  rawSteps: unknown,
  fallbackSectionName: string,
  sectionIndex: number
): PlanSection[] {
  if (!Array.isArray(rawSteps)) return []

  const grouped = new Map<string, PlanStep[]>()
  rawSteps.forEach((raw, stepIndex) => {
    const step = normalizePlanStep(
      raw,
      `plan-step-${sectionIndex + 1}-${stepIndex + 1}`
    )
    if (!step) return
    const sectionName = step.section || fallbackSectionName
    const existing = grouped.get(sectionName) ?? []
    existing.push({ id: step.id, text: step.text, done: step.done })
    grouped.set(sectionName, existing)
  })

  return Array.from(grouped.entries()).map(([name, steps]) => ({
    name,
    steps,
  }))
}

function normalizeSections(record: JsonRecord): PlanSection[] {
  const sections: PlanSection[] = []
  const rawSections = Array.isArray(record.sections)
    ? record.sections
    : Array.isArray(record.phases)
      ? record.phases
      : []

  rawSections.forEach((raw, sectionIndex) => {
    if (!isRecord(raw)) return
    const name =
      readString(raw, ["name", "title", "phase", "section"]) ||
      `Phase ${sectionIndex + 1}`
    const rawSteps =
      raw.steps ?? raw.tasks ?? raw.todos ?? raw.checklist ?? raw.items
    const steps = normalizeStepArray(rawSteps, name, sectionIndex).flatMap(
      (section) => section.steps
    )
    pushSection(sections, name, steps)
  })

  const rootStepArrays = [
    record.steps,
    record.tasks,
    record.todos,
    record.checklist,
    record.plan,
  ]
  for (const rawSteps of rootStepArrays) {
    for (const section of normalizeStepArray(
      rawSteps,
      "Tasks / Todos",
      sections.length
    )) {
      pushSection(sections, section.name, section.steps)
    }
  }

  return sections
}

function normalizeLinks(rawLinks: unknown): { text: string; href: string }[] {
  if (!Array.isArray(rawLinks)) return []

  const links: { text: string; href: string }[] = []
  const seen = new Set<string>()

  for (const raw of rawLinks) {
    let href = ""
    let text = ""
    if (typeof raw === "string") {
      href = raw.trim()
      text = href
    } else if (isRecord(raw)) {
      href = readString(raw, ["href", "url", "link"])
      text = readString(raw, ["text", "title", "label", "name"]) || href
    }
    if (!href || !/^https?:\/\//i.test(href) || seen.has(href)) continue
    seen.add(href)
    links.push({ text, href })
  }

  return links
}

function normalizeNotes(rawNotes: unknown): string[] {
  if (!Array.isArray(rawNotes)) return []
  return rawNotes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter(Boolean)
}

function buildJsonPreview(input: {
  title: string
  description: string
  sections: PlanSection[]
  links: { text: string; href: string }[]
  notes: string[]
}): string {
  const lines: string[] = [`# ${input.title}`]
  if (input.description) lines.push("", input.description)

  lines.push("", "## Plan Outline")
  for (const section of input.sections) {
    lines.push(
      `- ${section.name}: ${section.steps.length} task${section.steps.length === 1 ? "" : "s"}`
    )
  }

  if (input.notes.length > 0) {
    lines.push("", "## Notes")
    for (const note of input.notes) lines.push(`- ${note}`)
  }

  if (input.links.length > 0) {
    lines.push("", "## Links")
    for (const link of input.links) lines.push(`- [${link.text}](${link.href})`)
  }

  return lines.join("\n").trim()
}

function parseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function scanBalancedJson(text: string, start: number): string | null {
  const open = text[start]
  const close = open === "{" ? "}" : open === "[" ? "]" : ""
  if (!close) return null

  const stack = [close]
  let inString = false
  let escaped = false

  for (let idx = start + 1; idx < text.length; idx += 1) {
    const char = text[idx]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]")
      continue
    }
    if (char === "}" || char === "]") {
      if (stack[stack.length - 1] !== char) return null
      stack.pop()
      if (stack.length === 0) return text.slice(start, idx + 1)
    }
  }

  return null
}

function jsonCandidatesFromText(text: string): string[] {
  const trimmed = text.trim()
  const candidates: string[] = []
  if (trimmed) candidates.push(trimmed)

  const fenceRegex = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi
  let fenceMatch: RegExpExecArray | null
  while ((fenceMatch = fenceRegex.exec(text))) {
    const body = fenceMatch[1]?.trim()
    if (body) candidates.push(body)
  }

  const maxCandidates = 50
  for (
    let idx = 0;
    idx < text.length && candidates.length < maxCandidates;
    idx += 1
  ) {
    const char = text[idx]
    if (char !== "{" && char !== "[") continue
    const balanced = scanBalancedJson(text, idx)
    if (balanced) candidates.push(balanced)
  }

  return Array.from(new Set(candidates))
}

function normalizePlanObject(value: unknown): JsonRecord | null {
  if (Array.isArray(value)) return { plan: value }
  if (!isRecord(value)) return null
  return value
}

function mightContainPlanJson(text: string): boolean {
  const lowered = text.toLowerCase()
  return (
    lowered.includes("betterc0de.plan") ||
    lowered.includes('"sections"') ||
    lowered.includes('"steps"') ||
    lowered.includes('"tasks"') ||
    lowered.includes('"plan"')
  )
}

export function parseBetterC0dePlanJson(text: string): ParsedPlan | null {
  if (!mightContainPlanJson(text)) return null

  for (const candidate of jsonCandidatesFromText(text)) {
    const parsed = parseJsonCandidate(candidate)
    const record = normalizePlanObject(parsed)
    if (!record) continue

    const type = readString(record, ["type", "kind"])
    const hasRecognizedType = PLAN_TYPE_VALUES.has(type.toLowerCase())
    const sections = normalizeSections(record)
    if (!hasRecognizedType && sections.length === 0) continue
    if (sections.length === 0) continue

    const title = readString(record, ["title", "name", "heading"]) || "Plan"
    const description = readString(record, [
      "description",
      "overview",
      "summary",
      "goal",
    ])
    const links = normalizeLinks(record.links)
    const notes = normalizeNotes(record.notes ?? record.assumptions)

    return {
      title,
      description,
      sections,
      links,
      previewContent: buildJsonPreview({
        title,
        description,
        sections,
        links,
        notes,
      }),
      rawContent: text,
    }
  }

  return null
}

export function isBetterC0dePlanJson(text: string): boolean {
  return parseBetterC0dePlanJson(text) !== null
}

export function providerPlanStepsToTasks(
  plan: unknown
): { text: string; completed: boolean }[] {
  if (!Array.isArray(plan)) return []
  return plan
    .map((raw, index) => normalizePlanStep(raw, `plan-step-${index + 1}`))
    .filter((step): step is PlanStep => step !== null)
    .map((step) => ({ text: step.text, completed: step.done }))
}

export function buildBetterC0dePlanJson(input: {
  title?: string
  description?: string
  tasks?: { id?: string; text: string; completed?: boolean }[]
  sections?: {
    name: string
    steps: { id?: string; text: string; completed?: boolean }[]
  }[]
  links?: { text: string; href: string }[]
}): string {
  const sectionInput =
    input.sections
      ?.map((section, sectionIndex) => ({
        name: section.name.trim() || `Section ${sectionIndex + 1}`,
        steps: section.steps
          .filter((step) => step.text.trim())
          .map((step, stepIndex) => ({
            id: step.id || `step-${sectionIndex + 1}-${stepIndex + 1}`,
            text: step.text.trim(),
            status: step.completed ? "completed" : "pending",
          })),
      }))
      .filter((section) => section.steps.length > 0) ?? []
  const sections =
    sectionInput.length > 0
      ? sectionInput
      : [
          {
            name: "Tasks / Todos",
            steps: (input.tasks ?? [])
              .filter((task) => task.text.trim())
              .map((task, index) => ({
                id: task.id || `step-${index + 1}`,
                text: task.text.trim(),
                status: task.completed ? "completed" : "pending",
              })),
          },
        ]

  return JSON.stringify(
    {
      type: "betterc0de.plan",
      version: 1,
      title: input.title || "Plan",
      ...(input.description ? { description: input.description } : {}),
      sections,
      ...(input.links && input.links.length > 0 ? { links: input.links } : {}),
    },
    null,
    2
  )
}

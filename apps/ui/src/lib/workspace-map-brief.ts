import type { WorkspaceMapOverview } from "@/services/backend/workspaceApi"

const MAX_TOP_DIRECTORIES = 6
const MAX_ENTRY_POINTS = 8
const MAX_LARGEST_FILES = 6

export function buildWorkspaceMapBrief(
  overview: WorkspaceMapOverview,
  input: { projectPath?: string | null } = {}
): string {
  const lines = [
    "# Workspace Brief",
    "",
    `Project: ${input.projectPath?.trim() || overview.rootName || "Workspace"}`,
    `Files: ${overview.totalFiles.toLocaleString()} scanned${overview.truncated ? " (truncated)" : ""}`,
    `Code files: ${overview.codeFiles.toLocaleString()}`,
    `Size: ${formatWorkspaceBriefBytes(overview.totalBytes)}`,
  ]

  const topDirectories = overview.topDirectories.slice(0, MAX_TOP_DIRECTORIES)
  if (topDirectories.length > 0) {
    lines.push(
      "",
      "## Main Areas",
      ...topDirectories.map(
        (directory) =>
          `- ${directory.path || overview.rootName}: ${directory.codeFileCount.toLocaleString()} code / ${directory.fileCount.toLocaleString()} files`
      )
    )
  }

  if (overview.extensions.length > 0) {
    lines.push(
      "",
      "## File Types",
      ...overview.extensions
        .slice(0, 8)
        .map(
          (extension) =>
            `- ${extension.label}: ${extension.fileCount.toLocaleString()} files`
        )
    )
  }

  const entryPoints = overview.importantFiles.slice(0, MAX_ENTRY_POINTS)
  if (entryPoints.length > 0) {
    lines.push(
      "",
      "## Entry Points",
      ...entryPoints.map((file) => `- ${file.path} (${file.kind})`)
    )
  }

  const largestFiles = overview.largestFiles.slice(0, MAX_LARGEST_FILES)
  if (largestFiles.length > 0) {
    lines.push(
      "",
      "## Largest Files",
      ...largestFiles.map(
        (file) =>
          `- ${file.path} (${formatWorkspaceBriefBytes(file.sizeBytes)})`
      )
    )
  }

  return lines.join("\n")
}

export function formatWorkspaceBriefBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${formatBriefDecimal(value / 1024)} KB`
  if (value < 1024 * 1024 * 1024) {
    return `${formatBriefDecimal(value / (1024 * 1024))} MB`
  }
  return `${formatBriefDecimal(value / (1024 * 1024 * 1024))} GB`
}

function formatBriefDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}

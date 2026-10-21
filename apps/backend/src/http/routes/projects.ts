import type { Hono } from "hono"
import type { AppState } from "../../appState"
import type { ProjectProjection } from "../../persistence/projections"

interface ProjectListItem {
  readonly id?: string
  readonly name: string
  readonly path: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

export function registerProjectsRoutes(api: Hono, state: AppState): void {
  api.get("/projects", (c) => c.json(listProjects(state)))
}

function listProjects(state: AppState): ProjectListItem[] {
  const projects = new Map<string, ProjectListItem>()
  for (const project of state.projectProjections.listAll()) {
    const item = projectProjectionToListItem(project)
    projects.set(projectListKey(item), item)
  }

  // Legacy fallback: older BetterC0de data had no project projection and
  // derived projects from active thread rows. Keep that behavior, but don't
  // let it overwrite the thread-derived project projection.
  for (const raw of state.threads.listProjects() as ProjectListItem[]) {
    const item = {
      name: raw.name,
      path: raw.path,
    }
    const key = projectListKey(item)
    if (!projects.has(key)) projects.set(key, item)
  }

  return Array.from(projects.values())
}

function projectProjectionToListItem(
  project: ProjectProjection
): ProjectListItem {
  return {
    id: project.project_id,
    name: project.name,
    path: project.path,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }
}

function projectListKey(
  project: Pick<ProjectListItem, "name" | "path">
): string {
  const pathKey = project.path.trim()
  return pathKey ? `path:${pathKey}` : `name:${project.name.trim()}`
}

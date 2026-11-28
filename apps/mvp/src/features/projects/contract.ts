import { isRepository } from "../repo/contract.ts"

export const PROJECTS_ROUTE = "/api/me/projects"
export const PROJECT_STATUS_ROUTE = `${PROJECTS_ROUTE}/summaries`
export const PROJECTS_QUERY = "core/projects"

/** The expected person remains bound even when browser transport also adds its device principal. */
export const PROJECT_PERSON_HEADER = "x-smithers-project-person"

/** A saved link uses a canonical app repository path. @throws {never} */
export function projectId(input: string): string | undefined {
  const [owner, name, ...extra] = input.split("/")
  return owner !== undefined && name !== undefined && extra.length === 0 && isRepository(owner, name)
    ? input.toLowerCase()
    : undefined
}

export const PROJECTS_TELEMETRY = {
  records: ["projects.read", "projects.load", "smithers_projects_loads", "projects.add", "smithers_projects_adds"],
  fields: ["operation", "outcome"],
} as const

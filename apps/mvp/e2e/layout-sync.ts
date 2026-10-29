import type { Role } from "../src/features/auth/contract"

const SOURCES = ["item-summaries", "github-sync", "triage-settings", "github-writes"]

/** Initial snapshots of every source that can add controls to the signed-in Issues page. */
export class IssueLayoutSync {
  private member: boolean | undefined
  private readonly complete = new Set<string>()
  private readonly installed = new Set<string>()
  constructor(readonly repository: string) {}

  authority(role: Role | null): void {
    this.member = role !== null && ["member", "maintainer", "admin"].includes(role)
  }

  answered(path: string, repository: string | null, status: number, complete: boolean): void {
    if (status !== 200 || !complete) return
    const source = path.slice("/api/shapes/".length)
    if (source === "github-writes" || repository === this.repository) this.complete.add(source)
  }

  applied(source: string, repository: string): void {
    if (source === "github-writes" && repository === "*" || repository === this.repository) this.installed.add(source)
  }

  behind(): string[] {
    return [
      ...(this.member === undefined ? ["repository role"] : []),
      ...SOURCES,
      ...(this.member === true ? ["todos"] : []),
    ].filter(source => !this.complete.has(source) || !this.installed.has(source))
  }
}

/** Effect's browser console keeps fixed record names and JSON annotations; unknown formats fail closed. */
export const appliedRecord = (text: string): { source: string; repository: string } | undefined => {
  const prefix = "shape.initial.applied "
  const at = text.indexOf(prefix)
  if (at < 0) return undefined
  try {
    const fields = JSON.parse(text.slice(at + prefix.length)) as { source?: unknown; repository?: unknown } | null
    return fields !== null && typeof fields.source === "string" && typeof fields.repository === "string"
      ? { source: fields.source, repository: fields.repository } : undefined
  } catch { return undefined }
}

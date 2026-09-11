import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { reachable } from "@smthrs/rpc/TargetGraph"
import type { AffectedResponse, GraphEdge, GraphNode } from "@smthrs/rpc/TargetGraph"
import { declarationBindings } from "./DeclarationBindings"

export interface DeclaredInput { readonly pattern: string; readonly source: "plan" | "declaration" }
export type DeclaredInputs = ReadonlyMap<string, ReadonlyArray<DeclaredInput>>

const labelFor = (packageDir: string, name: string): string => packageDir === "" ? `//:${name}` : `//${packageDir}:${name}`
const normalizePattern = (packageDir: string, pattern: string): string => {
  if (pattern.startsWith("//")) return pattern.slice(2)
  return posix.join(packageDir, pattern)
}

/** Best-effort static extraction of imported Smithers file/glob inputs and local data references. */
export const declarationInputs = async (repo: string, files: ReadonlyArray<string>): Promise<DeclaredInputs> => {
  /*
   * This runs inside the affected route's handler, so the reads are async:
   * a monorepo-scale declaration set read with readFileSync is one unbroken
   * block of the server's event loop (AffectedBlocking.test.ts holds a 10ms
   * heartbeat across it). Reads go in modest batches — fast, and the loop
   * breathes between files.
   */
  const sources = new Map<string, string>()
  const BATCH = 64
  for (let offset = 0; offset < files.length; offset += BATCH) {
    await Promise.all(files.slice(offset, offset + BATCH).map(async (file) => {
      try { sources.set(file, await readFile(join(repo, file), "utf8")) } catch { /* An unreadable declaration contributes nothing. */ }
    }))
  }
  const result = new Map<string, Array<DeclaredInput>>()
  for (const file of files) {
    const source = sources.get(file)
    if (source === undefined) continue
    const packageDir = posix.dirname(file) === "." ? "" : posix.dirname(file)
    const definitions = new Map<string, string>()
    for (const binding of declarationBindings(source)) {
      definitions.set(binding.name, source.slice(binding.start, binding.end))
    }
    const aliases: Array<string> = []
    for (const imported of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g)) {
      for (const specifier of imported[1]!.split(",")) {
        const smithers = /^\s*Smithers(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier)
        if (smithers !== null) aliases.push(smithers[1] ?? "Smithers")
      }
    }
    const calls = aliases.map((alias) => new RegExp(`(?<![\\w$])${alias.replace(/\$/g, "\\$")}\\.(?:file|glob)\\(\\s*(?:(["'])(.*?)\\1|\\[([\\s\\S]*?)\\])`, "g"))
    const memo = new Map<string, Array<string>>()
    const inputsFor = (name: string, visiting = new Set<string>()): Array<string> => {
      const known = memo.get(name)
      if (known !== undefined) return known
      if (visiting.has(name)) return []
      visiting.add(name)
      const block = definitions.get(name) ?? ""
      const direct: Array<string> = []
      for (const call of calls) {
        for (const match of block.matchAll(call)) {
          if (match[2] !== undefined) {
            if (!match[2].startsWith("!")) direct.push(match[2])
          } else {
            for (const quoted of match[3]!.matchAll(/(["'])(.*?)\1/g)) if (!quoted[2]!.startsWith("!")) direct.push(quoted[2]!)
          }
        }
      }
      for (const ref of definitions.keys()) {
        if (ref !== name && new RegExp(`\\b${ref}\\b`).test(block)) direct.push(...inputsFor(ref, new Set(visiting)))
      }
      // Keep references package-relative until the complete input list is resolved.
      const values = [...new Set(direct)]
      memo.set(name, values)
      return values
    }
    for (const name of definitions.keys()) {
      const values = [...new Set(inputsFor(name).map((pattern) => normalizePattern(packageDir, pattern)))]
      if (values.length > 0) result.set(labelFor(packageDir, name), values.map((pattern) => ({ pattern, source: "declaration" })))
    }
    // A declaration edit can change any target declared by that package.
    for (const name of definitions.keys()) {
      const label = labelFor(packageDir, name)
      result.set(label, [...(result.get(label) ?? []), { pattern: file, source: "declaration" }])
    }
  }
  return result
}

const globRegex = (pattern: string): RegExp => {
  let value = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "/" && pattern.slice(i) === "/**") {
      value += "(?:/.*)?"
      i += 2
    } else if (char === "*") {
      if (pattern[i + 1] === "*") {
        if ((i === 0 || pattern[i - 1] === "/") && pattern[i + 2] === "/") {
          value += "(?:.*/)?"
          i += 2
        } else { value += ".*"; i++ }
      } else value += "[^/]*"
    } else if (char === "?") value += "[^/]"
    else value += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`^${value}(?:/.*)?$`)
}

export const computeAffected = (options: {
  readonly repoId: string
  readonly base: string
  readonly changedFiles: ReadonlyArray<string>
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<GraphEdge>
  readonly declarations: DeclaredInputs
  readonly durationMs?: number
}): AffectedResponse => {
  const direct = new Map<string, Array<string>>()
  const compiled = new Map<string, RegExp>()
  let usedPlan = false
  let usedDeclarations = false
  for (const node of options.nodes) {
    const scanned = options.declarations.get(node.label) ?? []
    const planned = node.plan?.inputs
    // The plan owns source inputs; editing PACKAGE.ts can still change the target itself.
    const declarationFile = node.source?.file ?? posix.join(node.package.slice(2), "PACKAGE.ts")
    const declared = planned === undefined ? scanned : scanned.filter((input) => input.pattern === declarationFile)
    usedPlan ||= planned !== undefined
    usedDeclarations ||= declared.length > 0
    const patterns = [...declared.map((input) => input.pattern), ...(planned ?? []).map((input) => input.replace(/^\.\//, "").replace(/^\/\//, ""))]
    const matchers = patterns.map((pattern) => {
      let regex = compiled.get(pattern)
      if (regex === undefined) { regex = globRegex(pattern); compiled.set(pattern, regex) }
      return regex
    })
    const matches = options.changedFiles.filter((file) => matchers.some((regex) => regex.test(file)))
    if (matches.length > 0) direct.set(node.label, matches)
  }
  const affected = new Map<string, string>()
  for (const [label, files] of direct) {
    affected.set(label, `declared input: ${files.join(", ")}`)
    for (const dependent of reachable(options.edges, label, "rdeps")) {
      if (!affected.has(dependent)) affected.set(dependent, `transitive via ${label}`)
    }
  }
  return {
    repoId: options.repoId,
    base: options.base,
    changedFiles: [...options.changedFiles].sort(),
    affected: [...affected].map(([label, reason]) => ({ label, reason })).sort((a, b) => a.label.localeCompare(b.label)),
    signal: ["git status/diff", ...(usedPlan ? ["plan inputs"] : []), ...(usedDeclarations ? ["static declaration inputs"] : []), "reverse graph reachability"].join(" + "),
    limits: ["Computed/glob inputs hidden behind arbitrary TypeScript cannot be recovered without a CLI plan input list."],
    durationMs: options.durationMs ?? 0
  }
}

const git = async (repo: string, args: ReadonlyArray<string>): Promise<string> => {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout.trim()
}

export const changedFiles = async (repo: string): Promise<{ readonly base: string; readonly files: Array<string> }> => {
  const [base, status, diff] = await Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repo, ["diff", "--name-only", "HEAD"])
  ])
  const files = new Set(diff.split(/\r?\n/).filter(Boolean))
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue
    const path = line.slice(3).trim()
    files.add(path.includes(" -> ") ? path.split(" -> ").pop()! : path)
  }
  return { base, files: [...files] }
}

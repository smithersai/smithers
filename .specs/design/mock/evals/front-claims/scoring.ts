import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"

export const bannedClaims = [
  { text: "closed laptop", source: "CEO claim ruling" },
  { text: "crash or a closed", source: "CEO claim ruling" },
  { text: "Coding agents that land changes", source: "PM v1 rows 1-3" },
  { text: "reviewed, tested changes", source: "PM v1 rows 1-3" },
  { text: "Ready to merge", source: "PM default review rows 4-5" },
  { text: "landed by the lander", source: "PM default review rows 4-5" },
  { text: "landed in order by the lander", source: "PM default review rows 4-5" },
  { text: "Powered by Smithers", source: "effeck app-spec Monday launch" },
  { text: "agent wants to merge", source: "CEO claim ruling: an agent as merge subject (GitHub's person-subject \"cora wants to merge\" is allowed; orchestrator 02:27)" },
  { text: "reviewed", source: "PM final review A row 1: review with no person as its subject (\"In review · reviewed on the issue\")", personSubject: true }
] as const
/** A person-subject claim matches as a whole word and passes when a person is its subject ("maya reviewed", "reviewed by Maya"). */
const PERSON = "maya|cora|dev-ahn|will|ada|you|we|i|who|person|reviewer"
const PERSON_BEFORE = new RegExp(String.raw`(?:(?:^|[^\w-]|\\n)(?:${PERSON})|\$\{role\})\s+(?:has\s+|have\s+)?$`, "i")
const PERSON_AFTER = new RegExp(String.raw`^\s+(?:and\s+\w+\s+)?by\s+(?:the\s+)?(?:@?(?:${PERSON})|\$\{role\})(?![\w-])`, "i")
const personSubject = (html: string, at: number, length: number): boolean =>
  /[A-Za-z-]/.test(html[at - 1] ?? "") || /[A-Za-z]/.test(html[at + length] ?? "")
  || PERSON_BEFORE.test(html.slice(Math.max(0, at - 30), at)) || PERSON_AFTER.test(html.slice(at + length))
/** The -app dists left the delivered set on 2026-10-18 (PM final review A); MOCK_DISTS can still name them. */
export const defaultDists = ["dist-smithers-site", "dist-effeck-site", "dist-default-ui", "dist-effect-monorepo"]
export interface Output { dist: string; html: string }
export interface Score { score: number; reason: string }
export const mockRoot = resolve(import.meta.dirname, "../..")
export const allowedClaims: { phrase: string; contextIncludes: string; reason: string }[] = JSON.parse(readFileSync(new URL("./allowed.json", import.meta.url), "utf8"))
export const deliveredRoot = resolve(homedir(), "smithers/.specs/design/mock")
/** Newest index.html wins; delivered copy wins ties. Overrides are absolute. */
export const discoverDists = (root = mockRoot, overrides = process.env.MOCK_DISTS, delivered = deliveredRoot): string[] => {
  const exists = (dist: string) => existsSync(dist) && statSync(dist).isDirectory()
  if (overrides !== undefined) {
    const paths = overrides.split(",").map(value => value.trim()).filter(Boolean)
    if (paths.some(path => !isAbsolute(path))) throw new Error("MOCK_DISTS must contain absolute dist paths")
    return [...new Set(paths)].filter(exists)
  }
  const mtime = (dist: string) => statSync(existsSync(resolve(dist, "index.html")) ? resolve(dist, "index.html") : dist).mtimeMs
  return defaultDists.flatMap(name => {
    const candidates = [...new Set([resolve(root, name), resolve(delivered, name)])].filter(exists)
    candidates.sort((a, b) => mtime(b) - mtime(a) || Number(b.startsWith(resolve(delivered) + "/")) - Number(a.startsWith(resolve(delivered) + "/")))
    return candidates.slice(0, 1)
  })
}
export const readDist = (dist: string): Output => ({ dist, html: readFileSync(resolve(dist, "index.html"), "utf8") })
export const landing = (dist: string): "smithers" | "effeck" | undefined => {
  const name = basename(dist)
  return /^dist-smithers-(site|app)$/.test(name) ? "smithers" : /^dist-effeck-(site|app)$/.test(name) ? "effeck" : undefined
}
export const requiredFor = (dist: string): string[] => landing(dist) === "smithers"
  ? ["Smithers is a codebase maintainer agent.", "npx smthrs@next generate flow coding", "bunx smthrs@next generate flow coding", "Start app"]
  : landing(dist) === "effeck" ? ["npm create vibelang@latest my-app", "utm_source=effeck.dev"] : []
export const bannedClaimsScore = ({ html }: Output): Score => {
  const lower = html.toLowerCase()
  const hits: string[] = []
  const allowed: string[] = []
  for (const claim of bannedClaims) {
    let start = 0
    for (let at = lower.indexOf(claim.text.toLowerCase(), start); at !== -1; at = lower.indexOf(claim.text.toLowerCase(), start)) {
      if ("personSubject" in claim && personSubject(html, at, claim.text.length)) { start = at + claim.text.length; continue }
      const context = html.slice(Math.max(0, at - 60), at + claim.text.length + 60)
      const entry = allowedClaims.find(entry => entry.phrase.toLowerCase().includes(claim.text.toLowerCase()) && context.includes(entry.contextIncludes) && context.toLowerCase().includes(entry.phrase.toLowerCase()))
      const detail = `${JSON.stringify(html.slice(at, at + claim.text.length))} at ${at}: ${JSON.stringify(context)}`
      if (entry) allowed.push(`${detail} — ${entry.reason}`)
      else hits.push(detail)
      start = at + claim.text.length
    }
  }
  return { score: hits.length ? 0 : 1, reason: [...(hits.length ? hits : ["no banned claims"]), ...(allowed.length ? ["Allowed hits:", ...allowed] : [])].join("\n") }
}
export const requiredCopy = ({ dist, html }: Output): Score => {
  const required = requiredFor(dist)
  if (!required.length) return { score: 1, reason: "no landing" }
  const missing = required.filter(text => !html.includes(text))
  return { score: missing.length ? 0 : 1, reason: missing.length ? `missing: ${missing.join("; ")}` : `present: ${required.join("; ")}` }
}
/** Match the root's closing tag, including nested elements with the same tag.
 * Never inspect the inline JavaScript as prerender evidence. */
export const prerenderedBody = (html: string): string => {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? ""
  const root = /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*["']root["'][^>]*>/i.exec(body)
  if (!root) return ""
  const content = body.slice(root.index + root[0].length).split(/<script\b/i)[0]!
  const tags = new RegExp(`<(/?)${root[1]}\\b[^>]*>`, "gi")
  let depth = 1
  for (const match of content.matchAll(tags)) {
    depth += match[1] ? -1 : /\/\s*>$/.test(match[0]) ? 0 : 1
    if (!depth) return content.slice(0, match.index)
  }
  return ""
}
export const staticFirstScreen = ({ dist, html }: Output): Score => {
  const kind = landing(dist)
  if (!kind) return { score: 1, reason: "no landing" }
  const markup = prerenderedBody(html)
  const command = requiredFor(dist)[kind === "smithers" ? 1 : 0]!
  const problems: string[] = []
  if (!markup.replace(/<!--[\s\S]*?-->/g, "").trim()) problems.push("empty prerender")
  if (!markup.includes(command)) problems.push(`missing first-screen: ${command}`)
  if (kind === "smithers") for (const link of markup.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const text = link[1]!.replace(/<[^>]*>/g, "").trim()
    if (/\b(?:Status|MIT)\b/i.test(text)) problems.push(`forbidden first-screen link: ${text}`)
  }
  return { score: problems.length ? 0 : 1, reason: problems.join("; ") || `prerender contains ${command}` }
}
export const scorers = { "banned-claims": bannedClaimsScore, "required-copy": requiredCopy, "static-first-screen": staticFirstScreen }

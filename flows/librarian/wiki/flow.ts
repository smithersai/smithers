import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; the registration beside it reads the value
// back through this self-import, which resolves after this module evaluates.
import Wiki from "./flow.ts"
import { git, sourceRevision } from "../tutorial2-background_flows-git.ts"

export const WikiPage = Schema.Struct({ id: Schema.String, path: Schema.String, title: Schema.String,
  body: Schema.String, links: Schema.Array(Schema.String), tags: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.String), confidence: Schema.Number })
export const PublishedWikiPage = Schema.Struct({ id: Schema.String, slug: Schema.String })
export const WikiReceipt = Schema.Struct({ repo: Schema.String, sourceHead: Schema.String, pages: Schema.Array(WikiPage),
  publishedPages: Schema.optional(Schema.Array(PublishedWikiPage)) })
export type WikiReceipt = typeof WikiReceipt.Type
export const Input = Schema.Struct({ repo: Schema.NonEmptyString })

/** A bounded, factual source index. No model inference is presented as codebase knowledge. */
export const generateWiki = async (root: string, repo: string): Promise<WikiReceipt> => {
  const { head } = await sourceRevision(root)
  const paths = (await git(root, ["ls-tree", "-r", "--name-only", "-z", head])).split("\0").filter(Boolean)
  if (paths.length > 20000) throw new Error("The repository exceeds the Wiki source-index limit.")
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const group = path.includes("/") ? path.split("/")[0]! : "root"
    groups.set(group, [...(groups.get(group) ?? []), path])
  }
  const prefix = `librarian/${encodeURIComponent(repo)}/${head}`
  const pages: WikiReceipt["pages"][number][] = []
  const pagePaths = [...groups.keys()].sort().map(group => `${prefix}/${encodeURIComponent(group)}.md`)
  pages.push({ id: `${prefix}/index`, path: `${prefix}/index.md`, title: `${repo} Wiki`,
    body: `# ${repo}\n\nSource revision: ${head}\n\nThis index records tracked paths at that revision.\n\n${pagePaths.map(path => `- [[${path}]]`).join("\n")}`,
    links: pagePaths, tags: ["source-index"], sources: [`git:${repo}@${head}`], confidence: 1 })
  for (const group of [...groups.keys()].sort()) {
    const files = groups.get(group)!
    pages.push({ id: `${prefix}/${encodeURIComponent(group)}`, path: `${prefix}/${encodeURIComponent(group)}.md`, title: group,
      body: `# ${group}\n\nSource revision: ${head}\n\n${files.map(path => `- ${JSON.stringify(path)}`).join("\n")}\n\n[[${prefix}/index.md]]`,
      links: [`${prefix}/index.md`], tags: ["source-index"], sources: files.map(path => `git:${repo}@${head}:${path}`), confidence: 1 })
  }
  return { repo, sourceHead: head, pages }
}
export const CreateWiki = Action.make("librarian/create-wiki", { payload: Input, success: WikiReceipt, error: Schema.String })

/**
 * `modelInvocable: false` because `librarian/create-wiki` is implemented by the
 * product host alone. This file sits in a repository any host may scan, and a
 * catalog elsewhere would otherwise teach an agent a call with no
 * implementation to reach.
 */
export default Flow.make("librarian/CreateWiki", {
  description: "Create a Markdown Wiki from the repository source tree with revision provenance and linked pages.",
  capabilities: ["fs:read:**", "wiki:write"],
  effects: { reads: ["**"], writes: ["wiki/**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: false,
  payload: Input, success: WikiReceipt, error: Schema.String,
  body: input => CreateWiki.call(input)
})

/** The host resolves the authorized workspace; persistence upserts immutable revision-scoped pages into its Wiki collection. */
export const registration = (root: string, persist: (receipt: WikiReceipt) => Promise<void | ReadonlyArray<typeof PublishedWikiPage.Type>>, owningRepo?: string) => Layer.mergeAll(
  CreateWiki.toLayer(({ repo }) => Effect.tryPromise({ try: async () => {
    if (owningRepo !== undefined && repo !== owningRepo) throw new Error("The requested repository does not own this workspace.")
    const receipt = await generateWiki(root, repo)
    const publishedPages = await persist(receipt)
    return publishedPages === undefined ? receipt : { ...receipt, publishedPages }
  }, catch: cause => String(cause) })), Interpreter.layer(Wiki)
).pipe(Layer.provideMerge(Action.layerImplementations))

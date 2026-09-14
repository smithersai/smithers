import { Flow as Declaration } from "@smthrs/core"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { git, sourceRevision, commitEnvironment } from "../tutorial2-background_flows-git.ts"

const Input = Schema.Struct({ repo: Schema.NonEmptyString })
export const HistoryReceipt = Schema.Struct({ repo: Schema.String, sourceHead: Schema.String, sourceTree: Schema.String,
  mythicalHead: Schema.String, notesHead: Schema.String, treeEqual: Schema.Boolean })
export type HistoryReceipt = typeof HistoryReceipt.Type
const ref = async (root: string, name: string) => {
  // Missing refs are absent; every other Git error is a failure.
  const result = await git(root, ["for-each-ref", "--format=%(objectname)", name])
  return result || null
}
/** Bootstrap is create-only. Deterministic objects + atomic CAS make crash replay safe. */
export const generateHistory = async (root: string, repo: string): Promise<HistoryReceipt> => {
  const { head, tree, date } = await sourceRevision(root)
  const environment = commitEnvironment(date)
  const mythicalHead = await git(root, ["commit-tree", tree], `Create Mythical history\n\nSource: ${head}\n`, environment)
  const note = `---\nversion: 1\nsourceHead: ${head}\nsourceTree: ${tree}\nconfidence: 1\nactor: smithers\n---\n\n## Tried\nCreated a repository snapshot at the captured source revision.\n\n## Evidence\nSource commit: ${head}\nSource and mythical tree: ${tree}\n\n## Folded\nNo outside merges were folded.\n\n## Superseded\nNo existing mythical history was replaced.\n`
  const blob = await git(root, ["hash-object", "-w", "--stdin"], note)
  const notesTree = await git(root, ["mktree"], `100644 blob ${blob}\t${mythicalHead}\n`)
  const notesHead = await git(root, ["commit-tree", notesTree], `Mythical history provenance for ${head}\n`, environment)
  const existing = await ref(root, "refs/heads/mythical")
  const existingNotes = await ref(root, "refs/notes/mythical")
  if (existing === mythicalHead && existingNotes === notesHead) return { repo, sourceHead: head, sourceTree: tree, mythicalHead, notesHead, treeEqual: true }
  if (existing || existingNotes) throw new Error("Mythical history already exists. Bootstrap will not replace it.")
  if (await git(root, ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD moved. Retry against the new source revision.")
  // Verify the source branch and create BOTH refs in one ref transaction.
  const sourceRef = await git(root, ["symbolic-ref", "-q", "HEAD"])
  if (sourceRef === "refs/heads/mythical") throw new Error("Select the source branch before creating mythical history.")
  await git(root, ["update-ref", "--stdin"], `start\nverify ${sourceRef} ${head}\ncreate refs/heads/mythical ${mythicalHead}\ncreate refs/notes/mythical ${notesHead}\nprepare\ncommit\n`)
  const actual = await git(root, ["rev-parse", `${mythicalHead}^{tree}`])
  if (actual !== tree) throw new Error("The mythical history tree differs from the captured source tree.")
  return { repo, sourceHead: head, sourceTree: tree, mythicalHead, notesHead, treeEqual: true }
}
export const CreateHistory = Action.make("librarian/create-history", { payload: Executable.Invocation, success: HistoryReceipt, error: Schema.String })
export const History = Flow.make("librarian/CreateHistory", { payload: Executable.Invocation, success: HistoryReceipt, error: Schema.String,
  body: input => CreateHistory.call(input) })
export const registration = (root: string, owningRepo?: string) => Layer.mergeAll(
  CreateHistory.toLayer(({ input }) => Effect.tryPromise({ try: async () => {
      const { repo } = Schema.decodeUnknownSync(Input)(input)
      if (owningRepo !== undefined && repo !== owningRepo) throw new Error("The requested repository does not own this workspace.")
      return generateHistory(root, repo)
    }, catch: cause => String(cause) })),
  Interpreter.layer(History)
).pipe(Layer.provideMerge(Action.layerImplementations))

export default Declaration.make({
  description: "Create Mythical history and provenance notes atomically, preserving the source branch and tree.",
  input: Input, output: HistoryReceipt, capabilities: ["fs:read:**", "fs:write:.git/**"], flows: ["librarian/CreateHistory"],
  effects: { reads: ["**"], writes: [".git/refs/heads/mythical", ".git/refs/notes/mythical", ".git/objects/**"], mode: "expected", onConflict: "serialize", tier: "sealed" }
})

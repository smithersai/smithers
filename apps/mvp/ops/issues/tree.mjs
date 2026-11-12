// The issue tree on smithersai/vibelang (Will, 2026-11-02): every issue serves "Ship VibeLang", through one of its
// sub-goals. Each imported record gets a parent here; the plan (import.mjs) shows the placement, and the poster files
// each issue as a GitHub sub-issue of its parent (track.mjs `parent`).
//
// GitHub's limits (docs.github.com, checked 2026-11-02): 100 sub-issues per parent, eight levels, and a child of the
// same owner in any repository. So smithersai/smithers items hang straight under these nodes as cross-repository
// children, no mirrored parent; and a node's items past its direct places go in numbered part nodes beneath it.
//
// GitHub cannot move a filed sub-issue (issues/file-tree reuses an issue by its key and refuses a different parent), so
// a record never changes place between imports: each node keeps PART_SLOTS of its 100 places for part nodes from the
// start, a new record only ever takes a free place, and the previous plan's places hold (`place`'s `previous`).
import { MAX_DEPTH, MAX_SUB_ISSUES } from "./track.mjs"

export const TREE_REPO = "smithersai/vibelang"
export const ROOT = "tree:ship-vibelang"
export const MIGRATED_REPOS = ["alchemy", "foldkit", "opencode", "t3code", "smithers"]
/** The places each node keeps for part nodes: room for 1,000 more items once its direct places are taken. */
export const PART_SLOTS = 10

/** The release's six gates, as the 0.0.11 release audit names them. */
const GATES = [
  ["postmerge", "Gate 1: post-merge is green on the release commit"],
  ["core-vip", "Gate 2: core VIP behavior holds on a fresh build"],
  ["instructions", "Gate 3: shipped instructions compile and run"],
  ["packages", "Gate 4: packages, version, Effect pin and Windows"],
  ["notes", "Gate 5: release notes"],
  ["diagnostics", "Gate 6: diagnostic identity matches Appendix B"],
]

/** The fixed nodes: `[key, title, parent key, what it covers]`. */
export const NODES = [
  [ROOT, "Ship VibeLang", undefined, "The goal every issue here serves. Its children are the sub-goals; progress rolls up from them."],
  ["tree:spec", "Spec graded A", ROOT, "Review rounds, open spec findings, and Will's rulings in progress."],
  ["tree:impl", "Implementation graded A", ROOT, "Compiler and runtime defects against the spec."],
  ["tree:explicit-effects", "Explicit effects landed and green", ROOT, "The remaining fix-forwards of explicit effects."],
  ["tree:repos", "Example repos migrated", ROOT, "One child per example repository; each repository's blockers and bugs sit under it."],
  ...MIGRATED_REPOS.map((repo) => [`tree:repos:${repo}`, `Migrate ${repo}`, "tree:repos", `The ${repo} migration: its blockers and bugs (label migrate:${repo}).`]),
  ["tree:release", "Release 0.0.11", ROOT, "One child per release gate, six in all."],
  ...GATES.map(([key, title]) => [`tree:release:${key}`, title, "tree:release", "A release gate: it passes on one main, with its receipt."]),
  ["tree:tooling", "Tooling works", ROOT, "Bun, Vite, webpack, Metro, editors, linters and formatters."],
  ["tree:fuzz", "Fuzz coverage for every finding", ROOT, "Every review and fuzz finding has a generator and an oracle; open fuzz findings sit here by area."],
  ["tree:workflow", "vibe and main workflow", ROOT, "The stacked queue, the fixer and the green prefix."],
  ["tree:docs", "Docs and launch", ROOT, "User docs, the site and the launch."],
]

const has = (text, ...words) => words.some((word) => text.includes(word))

/** The node a draft's free-text `parent` names ("Ship VibeLang > Example repos > Smithers", "Tooling", ...). */
export const nodeOfParentText = (text) => {
  const t = String(text ?? "").toLowerCase()
  if (has(t, "example repo", "migrat")) {
    const repo = MIGRATED_REPOS.find((name) => t.includes(name))
    return repo === undefined ? "tree:repos" : `tree:repos:${repo}`
  }
  if (has(t, "release")) {
    const gate = /gate\s*(\d)/.exec(t)
    return gate === null || GATES[Number(gate[1]) - 1] === undefined ? "tree:release" : `tree:release:${GATES[Number(gate[1]) - 1][0]}`
  }
  if (has(t, "explicit effect", "flip")) return "tree:explicit-effects"
  if (has(t, "spec")) return "tree:spec"
  if (has(t, "implementation", "impl a")) return "tree:impl"
  if (has(t, "tooling")) return "tree:tooling"
  if (has(t, "fuzz")) return "tree:fuzz"
  if (has(t, "workflow", "queue", "vibe and main")) return "tree:workflow"
  if (has(t, "docs", "launch")) return "tree:docs"
  return undefined
}

/**
 * Places `records` (each with `key`, `title` and `parent`, a node key) in the tree: the fixed nodes, area nodes the
 * records ask for (`areaNodes`: `[key, title, parent]`), and part nodes beneath a node whose direct places are taken.
 * `previous` maps a record key to its parent in the last plan (`import.mjs --previous`): a record whose node is
 * unchanged keeps that place, so only new records take free places, in order: a direct place (all but PART_SLOTS of
 * GitHub's 100 sub-issues, less the node's child nodes), then an open part, then a new part. Returns
 * `{ nodes, records }`: every node and record with its final `parent` and `depth` (the root is 1). A record with
 * `asNode` naming a node becomes that node's issue. Throws for a record whose parent is not a node, for a record
 * with no free place, and when a depth would pass GitHub's eight levels.
 */
export const place = (records, areaNodes = [], previous = new Map()) => {
  const nodes = new Map()
  for (const [key, title, parent, about] of [...NODES, ...areaNodes.map(([k, t, p]) => [k, t, p, "An area of work, grouped to stay under GitHub's sub-issue limits."])]) {
    nodes.set(key, { key, kind: "node", repo: TREE_REPO, title, parent, about })
  }
  const children = new Map()
  const childrenOf = (key) => children.get(key) ?? children.set(key, { nodes: [], items: [] }).get(key)
  for (const node of nodes.values()) if (node.parent !== undefined) childrenOf(node.parent).nodes.push(node)
  // A tracking draft is its node's issue: the node takes its title, body and labels, and it is not a child.
  for (const record of records) {
    const node = record.asNode === undefined ? undefined : nodes.get(record.asNode)
    if (node !== undefined) Object.assign(node, { title: record.title, about: record.body, labels: record.labels, draft: record.key, repo: record.repo })
  }
  const placed = records.filter((record) => record.asNode === undefined || !nodes.has(record.asNode)).map((record) => {
    // No silent placement: a record whose parent is not a node of the tree is refused, never dropped under a default.
    if (!nodes.has(record.parent)) throw new Error(`${record.key} names ${record.parent}, which is not a node of the tree`)
    const out = { ...record }
    childrenOf(record.parent).items.push(out)
    return out
  })
  for (const [key, group] of children) {
    const room = MAX_SUB_ISSUES - PART_SLOTS - group.nodes.length
    const parts = [] // the item count of each `${key}:part-<n>`
    let direct = 0
    const fresh = []
    for (const item of group.items) {
      const was = previous.get(item.key)
      const part = was?.startsWith(`${key}:part-`) ? was.slice(key.length + 6) : ""
      if (was === key) direct++
      else if (/^[1-9]\d*$/.test(part)) {
        while (parts.length < Number(part)) parts.push(0)
        parts[Number(part) - 1]++
        item.parent = was
      } else fresh.push(item)
    }
    for (const item of fresh) {
      const open = parts.findIndex((count) => count < MAX_SUB_ISSUES)
      if (direct < room && group.nodes.length + direct + parts.length < MAX_SUB_ISSUES) direct++
      else if (open !== -1) {
        parts[open]++
        item.parent = `${key}:part-${open + 1}`
      } else if (group.nodes.length + direct + parts.length < MAX_SUB_ISSUES) {
        parts.push(1)
        item.parent = `${key}:part-${parts.length}`
      } else throw new Error(`${item.key} has no place: ${key}'s ${MAX_SUB_ISSUES} sub-issues are filed, and GitHub cannot move a sub-issue under a part node`)
    }
    const title = nodes.get(key).title
    for (let index = 0; index < parts.length; index++) {
      const part = { key: `${key}:part-${index + 1}`, kind: "node", repo: TREE_REPO, title: `${title}, part ${index + 1} of ${parts.length}`, parent: key, about: `Part ${index + 1} of ${title}'s items: GitHub holds at most ${MAX_SUB_ISSUES} sub-issues per issue.` }
      nodes.set(part.key, part)
    }
  }
  const depthOf = (key, seen = 0) => {
    if (seen > MAX_DEPTH + 1) throw new Error(`a cycle at ${key}`)
    const node = nodes.get(key)
    return node.parent === undefined ? 1 : 1 + depthOf(node.parent, seen + 1)
  }
  for (const node of nodes.values()) node.depth = depthOf(node.key)
  for (const record of placed) {
    record.depth = depthOf(record.parent) + 1
    if (record.depth > MAX_DEPTH) throw new Error(`${record.key} would sit at level ${record.depth}; GitHub nests ${MAX_DEPTH}`)
  }
  return { nodes: [...nodes.values()], records: placed }
}

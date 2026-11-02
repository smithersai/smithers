// The issue tree on smithersai/vibelang (Will, 2026-11-02): every issue serves "Ship VibeLang", through one of its
// sub-goals. Each imported record gets a parent here; the plan (import.mjs) shows the placement, and the poster files
// each issue as a GitHub sub-issue of its parent (track.mjs `parent`).
//
// GitHub's limits (docs.github.com, checked 2026-11-02): 100 sub-issues per parent, eight levels, and a child of the
// same owner in any repository. So smithersai/smithers items hang straight under these nodes as cross-repository
// children, no mirrored parent; and a node with more than 100 children gets numbered part nodes beneath it.
import { MAX_DEPTH, MAX_SUB_ISSUES } from "./track.mjs"

export const TREE_REPO = "smithersai/vibelang"
export const ROOT = "tree:ship-vibelang"
export const MIGRATED_REPOS = ["alchemy", "foldkit", "opencode", "t3code", "smithers"]

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

/** The node a queue entry's lane belongs under, by its name. */
export const nodeOfLane = (lane) => {
  const t = String(lane ?? "").toLowerCase()
  const repo = MIGRATED_REPOS.find((name) => t.includes(name))
  if (repo !== undefined) return `tree:repos:${repo}`
  if (/^(release|rel-)/.test(t)) return "tree:release"
  if (/^(spec|sl\d|sl-|rev-|decide|declstyle|vip\d|review)/.test(t)) return "tree:spec"
  if (/^(fz|fuzz|impl-hunt|oracle)/.test(t)) return "tree:fuzz"
  if (/^(core-|flip|nothrow|w2-|explicit|await)/.test(t)) return "tree:explicit-effects"
  if (/^(mq|platform|plat|cf|box|queue|fixer|main-red|postmerge|pm-)/.test(t)) return "tree:workflow"
  if (/^(docs|site|f3|launch)/.test(t)) return "tree:docs"
  if (/(bun|vite|webpack|metro|lsp|editor|format|fmt|lint|tooling|loader|plugin|unplugin|shim)/.test(t)) return "tree:tooling"
  return "tree:impl"
}

/**
 * Places `records` (each with `key`, `title` and `parent`, a node key) in the tree: the fixed nodes, area nodes the
 * records ask for (`areaNodes`: `[key, title, parent]`), and part nodes wherever a node would hold more than GitHub's
 * 100 sub-issues. Returns `{ nodes, records }`: every node and record with its final `parent` and `depth` (the root
 * is 1). A record with `asNode` naming a node becomes that node's issue. Throws when a depth would pass GitHub's eight
 * levels.
 */
export const place = (records, areaNodes = []) => {
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
    const parent = nodes.has(record.parent) ? record.parent : nodes.has(record.parentHint) ? record.parentHint : "tree:impl"
    const out = { ...record, parent }
    childrenOf(parent).items.push(out)
    return out
  })
  for (const [key, group] of [...children.entries()]) {
    if (group.nodes.length + group.items.length <= MAX_SUB_ISSUES) continue
    const room = MAX_SUB_ISSUES - group.nodes.length
    const parts = Math.ceil(group.items.length / MAX_SUB_ISSUES)
    if (parts > room) throw new Error(`${key} needs ${parts} part nodes and has room for ${room}`)
    const title = nodes.get(key).title
    for (let index = 0; index < parts; index++) {
      const part = { key: `${key}:part-${index + 1}`, kind: "node", repo: TREE_REPO, title: `${title}, part ${index + 1} of ${parts}`, parent: key, about: `Part ${index + 1} of ${title}'s items: GitHub holds at most ${MAX_SUB_ISSUES} sub-issues per issue.` }
      nodes.set(part.key, part)
      for (const item of group.items.slice(index * MAX_SUB_ISSUES, (index + 1) * MAX_SUB_ISSUES)) item.parent = part.key
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

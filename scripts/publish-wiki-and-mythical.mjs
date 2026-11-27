#!/usr/bin/env node
/**
 * Publishes `.smithers/wiki/` markdown pages and the repository's clean Mythical History snapshot
 * to Smithers Cloud (Shared Cloud Object Store + live Electric `feed_documents` feeds),
 * using either an authenticated MCP bearer token (`SMITHERS_MCP_TOKEN`) or a repository feed key
 * (`SMITHERS_FEED_KEY`).
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? "smithersai/smithers"
const mythicalOnly = process.argv.includes("--mythical-only")
const baseUrl = (process.env.SMITHERS_URL ?? "https://smithers.sh").replace(/\/+$/, "")
const mcpToken = process.env.SMITHERS_MCP_TOKEN
const feedKey = process.env.SMITHERS_FEED_KEY

if (!/^[^/]+\/[^/]+$/.test(repo)) {
  console.error("Usage: publish-wiki-and-mythical.mjs <owner/repo> [--mythical-only]")
  process.exit(2)
}

const [owner, name] = repo.split("/")

function collectMarkdown(dir, root = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectMarkdown(full, root, out)
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
      const rel = relative(root, full).replace(/\\/g, "/")
      const markdown = readFileSync(full, "utf8")
      const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel.replace(/\.mdx?$/, "")
      out.push({ path: rel, title: heading, markdown })
    }
  }
  return out
}

function readRecentMythicalCommits() {
  try {
    const raw = execSync(
      `jj --no-pager log -r '::@-' -n 12 --no-graph -T 'commit_id.short() ++ "\\t" ++ committer.timestamp().format("%Y-%m-%dT%H:%M:%SZ") ++ "\\t" ++ author.name() ++ "\\t" ++ description.first_line() ++ "\\n"'`,
      { encoding: "utf8" },
    )
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    return lines.map((line, index) => {
      const [sha, ts, author, ...titleParts] = line.split("\t")
      const title = titleParts.join(" ").trim() || "Untitled change"
      const epicMatch = title.match(/^[a-z]+(?:\(([^)]+)\))?:/)
      const epic = epicMatch?.[1] ?? "core"
      return {
        position: lines.length - index,
        epic,
        title,
        summary: `Folded into main at ${sha} (${ts})`,
        commitSha: sha,
        mainFoldedSha: sha,
        treeEqualToMain: index === 0,
        authorLogin: author || "roninjin10",
        notes: [
          { kind: "folded", summary: `Landed commit ${sha} on main`, ref: sha },
        ],
      }
    })
  } catch {
    return []
  }
}

async function callMcp(toolName, args) {
  const url = `${baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mcp`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${toolName}-${Date.now()}`,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  })
  if (!res.ok) {
    throw new Error(`MCP ${toolName} failed (${res.status}): ${await res.text()}`)
  }
  return res.json()
}

async function publishViaFeed(documents) {
  const url = `${baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/feeds`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${feedKey}`,
    },
    body: JSON.stringify({
      set: Object.fromEntries(documents.map((d) => [d.name, { visibility: "public", body: d.body }])),
    }),
  })
  if (!res.ok) {
    throw new Error(`Feed publish failed (${res.status}): ${await res.text()}`)
  }
}

const wikiDir = resolve(".smithers/wiki")
const wikiPages = mythicalOnly ? [] : collectMarkdown(wikiDir)
const mythicalCommits = readRecentMythicalCommits()

if (!mcpToken && !feedKey) {
  console.log(JSON.stringify({
    mode: "dry-run",
    repository: repo,
    wikiPages: wikiPages.length,
    mythicalCommits: mythicalCommits.length,
  }, null, 2))
  process.exit(0)
}

if (mcpToken) {
  for (const page of wikiPages) {
    await callMcp("wiki_write", { page: page.path, title: page.title, markdown: page.markdown })
  }
  for (const commit of mythicalCommits) {
    await callMcp("mythical_history_record", commit)
  }
  console.log(`Published ${wikiPages.length} wiki pages and ${mythicalCommits.length} mythical commits via MCP for ${repo}`)
} else if (feedKey) {
  const docs = []
  if (wikiPages.length > 0) {
    docs.push({ name: "wiki", body: { notes: wikiPages, updatedAt: new Date().toISOString() } })
  }
  if (mythicalCommits.length > 0) {
    docs.push({ name: "mythical", body: { commits: mythicalCommits, updatedAt: new Date().toISOString() } })
  }
  if (docs.length > 0) await publishViaFeed(docs)
  console.log(`Published ${docs.length} feed documents for ${repo}`)
}

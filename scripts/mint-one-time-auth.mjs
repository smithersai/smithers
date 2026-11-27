#!/usr/bin/env node
/**
 * Mint or redeem single-use Smithers Cloud sandbox/agent authentication tokens (`smot_` -> `sma_`).
 *
 * Usage:
 *   # Mint via authenticated MCP bearer token (prints shell + MCP snippets to stdout):
 *   SMITHERS_MCP_TOKEN=sma_... node scripts/mint-one-time-auth.mjs \
 *     --repo smithersai/smithers --purpose sandbox --ttl 300 --label ci-run-1
 *
 *   # Redeem inside an ephemeral sandbox (prints JSON `{ accessToken, mcpUrl, executionTrust, ... }`):
 *   SMITHERS_ONE_TIME_TOKEN=smot_... node scripts/mint-one-time-auth.mjs --redeem
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const idx = args.indexOf(name)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback
}
const hasFlag = (name) => args.includes(name)

const baseUrl = (flag("--url", process.env.SMITHERS_CLOUD_URL || "https://smithers.sh")).replace(/\/$/, "")

if (hasFlag("--redeem")) {
  const token = flag("--token", process.env.SMITHERS_ONE_TIME_TOKEN || "")
  if (!token.startsWith("smot_")) {
    console.error("Missing or invalid --token / SMITHERS_ONE_TIME_TOKEN (expected smot_ prefix)")
    process.exit(1)
  }
  const res = await fetch(`${baseUrl}/api/auth/one-time/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ token }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`Redeem failed (${res.status}): ${text}`)
    process.exit(1)
  }
  process.stdout.write(text + "\n")
  process.exit(0)
}

const repo = flag("--repo", process.env.SMITHERS_REPO || "smithersai/smithers")
const purpose = flag("--purpose", "sandbox")
const ttlSeconds = Number(flag("--ttl", "300"))
const label = flag("--label", undefined)
const mcpToken = process.env.SMITHERS_MCP_TOKEN || ""

if (!mcpToken) {
  console.error("Set SMITHERS_MCP_TOKEN (an authenticated sma_ bearer token) to mint a one-time sandbox token.")
  process.exit(1)
}

const res = await fetch(`${baseUrl}/${repo}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${mcpToken}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "auth_one_time_mint",
      arguments: {
        repository: repo,
        purpose,
        ttlSeconds,
        ...(label ? { label } : {}),
      },
    },
  }),
})

const raw = await res.text()
if (!res.ok) {
  console.error(`Mint failed (${res.status}): ${raw}`)
  process.exit(1)
}

let payload
try {
  const rpc = JSON.parse(raw)
  const contentText = rpc?.result?.content?.[0]?.text
  payload = contentText ? JSON.parse(contentText) : rpc
} catch {
  console.error(`Unexpected MCP response: ${raw}`)
  process.exit(1)
}

if (hasFlag("--json")) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n")
} else {
  process.stdout.write(`# Smithers Cloud One-Time Auth (${payload.purpose}, trust=${payload.executionTrust})\n`)
  process.stdout.write(`# Repository: ${payload.repository} | Expires: ${payload.expiresAt}\n\n`)
  process.stdout.write(`${payload.shellSnippet}\n`)
}

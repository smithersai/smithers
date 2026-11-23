/**
 * `smthrs fleet`: local-first Smithers host node daemon & fleet observability CLI (BYOA MCP-over-HTTP).
 * @since 1.0.0
 */

import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { Cli, z } from "incur"
import { hostname } from "node:os"
import * as McpRemote from "../cli/McpRemote.ts"
import * as CliError from "../CliError.ts"
import { defaultNodeId, inspectLocalSession, makeCollectorsLayer } from "../node/Collectors.ts"
import * as McpClient from "../node/McpClient.vibe"
import * as NodeDaemon from "../node/NodeDaemon.vibe"
import { packageVersion } from "../Version.ts"

const resolveToken = (origin: string, explicit?: string): string => {
  if (explicit && explicit.trim().length > 0) return explicit.trim()
  const fromEnv = process.env["SMITHERS_MCP_TOKEN"]?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const stored = McpRemote.readStoredToken(McpRemote.tokenStorePath(), origin)
  if (stored?.token) return stored.token
  throw new CliError.UsageError({
    message: `No MCP token for ${origin}. Run \`smthrs mcp login --origin ${origin}\` or set SMITHERS_MCP_TOKEN.`
  })
}

/**
 * Builds the `smthrs fleet` Incur CLI for host node sync, overview, and read-only session inspection.
 * @category cli
 * @since 1.0.0
 */
export const createNodeCli = () =>
  Cli.create("fleet", {
    version: packageVersion,
    description: "Run this machine as a local-first Smithers node syncing over BYOA MCP-over-HTTP"
  })
    .command("serve", {
      description:
        "Continuously observe normal Claude/Codex/AGY sessions, host health, accounts, and cfbox sandboxes and sync to Smithers",
      options: z.object({
        origin: z.string().default("https://smithers.sh"),
        nodeId: z.string().optional(),
        name: z.string().optional(),
        kind: z.enum(["macbook", "mac-mini", "bare-metal", "cloudflare", "lan"]).default("macbook"),
        intervalSeconds: z.number().int().min(5).max(300).default(15),
        accountIntervalSeconds: z.number().int().min(30).max(900).default(60),
        accounts: z.boolean().default(false),
        cfbox: z.boolean().default(false),
        once: z.boolean().default(false),
        token: z.string().optional()
      }),
      run: async (c) => {
        const origin = McpRemote.normalizeOrigin(c.options.origin)
        const token = resolveToken(origin, c.options.token)
        const nodeId = c.options.nodeId ?? defaultNodeId()
        const name = c.options.name ?? hostname()
        const collectors = makeCollectorsLayer({
          nodeId,
          name,
          kind: c.options.kind,
          labels: [c.options.kind, process.platform, process.arch],
          version: packageVersion
        })
        const program = NodeDaemon.runDaemon({
          mcp: { origin, token },
          intervalMs: c.options.intervalSeconds * 1000,
          accountIntervalMs: c.options.accountIntervalSeconds * 1000,
          collectAccounts: c.options.accounts,
          collectCfbox: c.options.cfbox,
          once: c.options.once
        }).pipe(Effect.provide(Layer.merge(collectors, FetchHttpClient.layer)))
        await Effect.runPromise(program)
        return { ok: true, nodeId, origin, once: c.options.once }
      }
    })
    .command("overview", {
      description:
        "Show live hosts, observed Claude/Codex/AGY sessions, and accounts (remotely from Smithers via MCP or locally with --local)",
      options: z.object({
        origin: z.string().default("https://smithers.sh"),
        local: z.boolean().default(false),
        accounts: z.boolean().default(true),
        cfbox: z.boolean().default(true),
        includeEnded: z.boolean().default(false),
        token: z.string().optional()
      }),
      run: async (c) => {
        if (c.options.local) {
          const nodeId = defaultNodeId()
          const collectors = makeCollectorsLayer({
            nodeId,
            name: hostname(),
            kind: process.platform === "darwin"
              ? (hostname().toLowerCase().includes("mini") ? "mac-mini" : "macbook")
              : "bare-metal",
            labels: [process.platform, process.arch],
            version: packageVersion
          })
          return await Effect.runPromise(
            Effect.gen(function*() {
              const col = yield* NodeDaemon.NodeCollectors
              const host = yield* col.collectHost()
              const sessions = yield* col.collectSessions()
              const accounts = c.options.accounts ? yield* col.collectAccounts() : []
              const cfbox = c.options.cfbox ? yield* col.collectCfbox() : null
              const nodes = cfbox
                ? [{ ...host, activeSessions: sessions.length }, cfbox.host]
                : [{ ...host, activeSessions: sessions.length }]
              const allSessions = cfbox ? [...sessions, ...cfbox.sessions] : sessions
              return { nodes, sessions: allSessions, accounts }
            }).pipe(Effect.provide(collectors))
          )
        }
        const origin = McpRemote.normalizeOrigin(c.options.origin)
        const token = resolveToken(origin, c.options.token)
        return await Effect.runPromise(
          McpClient.callTool({ origin, token }, "fleet_overview", {
            includeEnded: c.options.includeEnded
          }).pipe(Effect.provide(FetchHttpClient.layer))
        )
      }
    })
    .command("inspect", {
      description: "Read-only observability drill-down into a normal local Claude Code, Codex, or AGY session",
      args: z.object({
        session: z.string().describe("Session key or substring to inspect")
      }),
      run: async (c) => {
        const nodeId = defaultNodeId()
        return inspectLocalSession(
          {
            nodeId,
            name: hostname(),
            kind: process.platform === "darwin"
              ? (hostname().toLowerCase().includes("mini") ? "mac-mini" : "macbook")
              : "bare-metal",
            labels: [process.platform, process.arch],
            version: packageVersion
          },
          c.args.session
        )
      }
    })

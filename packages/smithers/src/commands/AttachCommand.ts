import { createHash, randomBytes } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { Cli, z } from "incur"
import { normalizeOrigin, serveMcpStdioBridge, type McpServeOptions } from "../cli/McpRemote.ts"

interface AttachOptions {
  readonly intent: string
  readonly origin?: string | undefined
  readonly approve: (pairing: string) => Promise<string>
  readonly fetchImpl?: typeof fetch
}

const claimResponse = z.object({ claim: z.string().min(1), pairing: z.string().regex(/^\d{6}$/) })
const redeemResponse = z.object({
  token: z.string().regex(/^smat_[A-Za-z0-9_-]+$/),
  mcpPath: z.string().regex(/^(?:\/api\/attach)?\/mcp\/[^/]+\/[^/]+\/.+$/),
  grant: z.object({ act: z.literal("agent"), expiresAt: z.number() })
})

export const redeem = async (options: AttachOptions) => {
  const intent = options.intent.trim().toUpperCase()
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(intent)) {
    throw new Error("Invalid attach intent")
  }
  const origin = normalizeOrigin(options.origin)
  const request = options.fetchImpl ?? fetch
  const post = async (path: string, body: object): Promise<unknown> => {
    const response = await request(new URL(path, origin), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`Attach request refused (HTTP ${response.status})`)
    return response.json()
  }
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const claim = claimResponse.safeParse(await post("/api/attach/claim", {
    reference: intent, client: "smthrs attach", challenge
  }))
  if (!claim.success) throw new Error("Invalid attach claim")
  const code = (await options.approve(claim.data.pairing)).trim()
  if (code === "") throw new Error("Attach approval code is required")
  const result = redeemResponse.safeParse(await post("/api/attach/redeem", {
    claim: claim.data.claim, code, verifier
  }))
  if (!result.success || result.data.grant.expiresAt <= Date.now()) throw new Error("Invalid or expired agent grant")
  const endpoint = new URL(result.data.mcpPath, origin)
  if (endpoint.origin !== origin || endpoint.pathname !== result.data.mcpPath) {
    throw new Error("Invalid agent MCP path")
  }
  return { token: result.data.token, endpoint }
}

export const attach = async (
  options: AttachOptions & Pick<McpServeOptions, "input" | "output" | "stderr" | "signal">
): Promise<void> => {
  const agentGrant = await redeem(options)
  await serveMcpStdioBridge({ ...options, agentGrant })
}

const approveInTerminal = async (pairing: string): Promise<string> => {
  // MCP owns stdin/stdout. Use the controlling terminal for the human exchange.
  const { createReadStream, createWriteStream } = await import("node:fs")
  const input = createReadStream("/dev/tty")
  const output = createWriteStream("/dev/tty")
  const terminal = createInterface({ input, output })
  try {
    return await terminal.question(`Pairing code ${pairing}. Enter the approval code: `)
  } finally {
    terminal.close()
    input.destroy()
    output.end()
  }
}

interface AttachHost extends Pick<McpServeOptions, "input" | "output" | "signal"> {
  readonly approve?: AttachOptions["approve"] | undefined
}

export const registerAttach = (host: AttachHost = {}) => Cli.create("attach", {
  description: "Attach an agent via a one-time intent",
  options: z.object({ intent: z.string(), origin: z.string().optional() }),
  run: ({ options }) => attach({ ...options, ...host, approve: host.approve ?? approveInTerminal })
})

/*
 * The secrets seam: the secrets a repository's sessions may use, read off the
 * agent-environment document (GET /api/repos/{owner}/{repo}/agent-environment,
 * EnvironmentSeam.ts). plue serves secret METADATA only: name, the egress
 * binding (hosts, match_headers) and the updated time. No value exists on the
 * wire, so none can reach a card, the journal or the model. Adding and
 * removing secrets land in later Secrets lanes.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readEnvironment } from "./EnvironmentSeam"
import type { SeamContext } from "./SeamContext"
import { readResult } from "./SeamContext"

export interface SecretsSeam {
  readonly listSecrets: (repo?: string) => Promise<string | { readonly value: string }>
}

export const createSecretsSeam = (ctx: SeamContext): SecretsSeam => {
  /*
   * One secrets card per repository, re-surfaced at the end of the transcript
   * on every list. Leaving it at its old ordinal would answer the command with
   * a silent no-op.
   */
  const listSecrets = async (repo?: string): Promise<string | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const config = await readEnvironment(ctx, target.repo)
    if (typeof config === "string") return config
    const card: Card = {
      id: `secrets-${target.repo}`,
      kind: "secrets",
      title: `Secrets · ${target.repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo: target.repo,
        scope: "repository",
        secrets: config.secrets.map((secret) => ({
          name: secret.name,
          hosts: [...secret.hosts],
          matchHeaders: [...secret.matchHeaders],
          updatedAt: secret.updatedAt
        }))
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return readResult(card.payload.secrets.length === 0
      ? `No secrets in ${card.payload.repo}.`
      : [
        `Secrets · ${card.payload.repo}`,
        ...card.payload.secrets.map((secret) =>
          `${secret.name} · hosts: ${secret.hosts.join(", ") || "none"} · headers: ${secret.matchHeaders.join(", ") || "none"} · updated: ${secret.updatedAt ?? "unknown"}`)
      ].join("\n"))
  }

  return { listSecrets }
}

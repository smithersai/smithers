// Stays .ts: Alchemy/rolldown load this build-time plugin directly, before VibeLang source is bundled.
import vibelang from "vibelang-unplugin/rolldown"
import { randomUUID } from "node:crypto"
import { instrumentRolldown } from "../test/support/workerdCoverage.ts"

export default function sandboxCoveragePlugin() {
  const selected = (path: string) => /\/apps\/vibelang\/(src|worker|infra)\/.*\.vibe$/.test(path.replaceAll("\\", "/"))
  const plugin = instrumentRolldown(vibelang() as never, selected) as unknown as { name: string; load(this: unknown, id: string): Promise<{ code: string } | null | undefined> }
  // A deploy always uploads a fresh bundle, including when the authored source is unchanged. Reserve vl-test for
  // one benchmark run after this deploy so cumulative isolate counters contain only that run and its startup.
  const buildId = randomUUID()
  return { ...plugin, async load(this: unknown, id: string) {
    const result = await plugin.load.call(this, id)
    return result && selected(id) ? { ...result, code: `globalThis.__sandboxBenchBuild = ${JSON.stringify(buildId)};\n${result.code}` } : result
  } } as ReturnType<typeof vibelang>
}

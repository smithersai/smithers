import { Clock, Effect, Option, Schema } from "effect"
import { isRepository, repoId } from "../src/features/repo/contract.ts"
import { FlowStarter } from "./Flows.ts"
import { Refresh } from "./flows/RepoRefresh.ts"

const Push = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  installation: Schema.Struct({ id: Schema.Number }),
  ref: Schema.String,
})
const decodePush = Schema.decodeUnknownOption(Push)

/** Called only after signature verification. Deletions also refresh the mirror's refs. */
export const pushRepository = (event: string, payload: unknown) => {
  if (event !== "push") return Option.none<{ owner: string; name: string }>()
  return Option.flatMap(decodePush(payload), (push) => {
    const parts = push.repository.full_name.split("/")
    const [owner = "", name = ""] = parts
    return parts.length === 2 && isRepository(owner, name) && push.installation.id > 0 && push.ref.startsWith("refs/")
      ? Option.some({ owner: owner.toLowerCase(), name: name.toLowerCase() }) : Option.none()
  })
}

/** One durable execution per delivery, or per minute for read/explicit refresh requests. No detached work. */
export const request = (owner: string, name: string, delivery?: string) => Effect.gen(function* () {
  const key = delivery === undefined ? `read:${Math.floor((yield* Clock.currentTimeMillis) / 60_000)}` : `push:${delivery}`
  yield* (yield* FlowStarter).start(Refresh, {
    executionId: `repo-refresh:${repoId(owner, name)}:${key}`,
    payload: { owner: owner.toLowerCase(), name: name.toLowerCase() },
  })
})

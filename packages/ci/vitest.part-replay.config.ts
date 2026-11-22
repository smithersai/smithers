// One part of //packages/ci:test (vitest.config.ts says why): the cases under test/replay, holding what `held.replay` names.
import { heldBy, suite } from "./vitest.config.ts"

export default suite({ include: ["test/replay/**/*.test.{ts,vibe}"], ...heldBy("replay") })

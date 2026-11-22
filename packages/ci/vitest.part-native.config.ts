// One part of //packages/ci:test (vitest.config.ts says why): the cases under test/native, holding what `held.native` names.
import { heldBy, partWorkers, suite } from "./vitest.config.ts"

export default suite({ include: ["test/native/**/*.test.{ts,vibe}"], ...heldBy("native"), workers: partWorkers.native })

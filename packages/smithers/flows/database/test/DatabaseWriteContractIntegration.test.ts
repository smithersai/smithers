import { describe, expect, it } from "@effect/vitest"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { describeContract } from "./contract/DatabaseWriteContract.ts"
import { fileContract } from "./harness/fileContract.ts"

describeContract(
  fileContract(
    "NodeDatabase, two connections over one file",
    (filename) => NodeDatabase.layer({ filename, sqlite: { busyTimeout: 5 } })
  ),
  { describe, expect, it }
)

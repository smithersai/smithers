/** @jsxImportSource smithers */
import { createSmithers, Workflow, Task } from "../../src/index";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(
  mkdtempSync(join(tmpdir(), "smithers-test-")),
  "db.sqlite",
);

const { smithers, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath },
);

export default smithers((_ctx) => (
  <Workflow name="test-workflow">
    <Task id="step1" output={outputs.outputA}>
      {{ value: 42 }}
    </Task>
  </Workflow>
));

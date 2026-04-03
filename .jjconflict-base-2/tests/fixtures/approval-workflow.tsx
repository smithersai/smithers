/** @jsxImportSource smithers */
import { createSmithers, Workflow, Task, Sequence } from "../../src/index";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(
  mkdtempSync(join(tmpdir(), "smithers-approval-")),
  "db.sqlite",
);

const { smithers, outputs } = createSmithers(
  {
    outputA: z.object({ value: z.number() }),
    outputB: z.object({ value: z.number() }),
  },
  { dbPath },
);

export default smithers((_ctx) => (
  <Workflow name="approval-workflow">
    <Sequence>
      <Task id="gate" output={outputs.outputA} needsApproval>
        {{ value: 1 }}
      </Task>
      <Task id="after" output={outputs.outputB}>
        {{ value: 2 }}
      </Task>
    </Sequence>
  </Workflow>
));

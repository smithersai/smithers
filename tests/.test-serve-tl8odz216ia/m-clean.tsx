/** @jsxImportSource smithers */
import { createSmithers } from "smithers";
import { z } from "zod";


const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "/Users/williamcory/smithers/tests/.test-serve-tl8odz216ia/m-clean.db" },
);

export default smithers((ctx) => (
  <Workflow name="m-clean">
    <Task id="task1" output={outputs.outputA}>
      {{ value: 42 }}
    </Task>
  </Workflow>
));

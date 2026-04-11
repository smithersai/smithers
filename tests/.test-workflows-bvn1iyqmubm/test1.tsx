/** @jsxImportSource smithers */
	import { createSmithers } from "smithers";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/tests/.test-workflows-bvn1iyqmubm/test1.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="test1">
	    <Task id="task1" output={outputs.outputA}>
	      {{ value: 42 }}
	    </Task>
	  </Workflow>
	));
	
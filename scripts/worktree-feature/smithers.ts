import { createSmithers } from "../../src/index.ts";
import { DiscoverOutput } from "./components/Discover.schema";
import { ImplementOutput } from "./components/Implement.schema";
import { ValidateOutput } from "./components/Validate.schema";
import { ReviewOutput } from "./components/Review.schema";
import { ReviewFixOutput } from "./components/ReviewFix.schema";
import { ReportOutput } from "./components/Report.schema";

export const {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Branch,
  Ralph,
  useCtx,
  smithers,
  tables,
  outputs,
} = createSmithers({
  discover: DiscoverOutput,
  implement: ImplementOutput,
  validate: ValidateOutput,
  review: ReviewOutput,
  reviewFix: ReviewFixOutput,
  report: ReportOutput,
}, { dbPath: `${process.env.HOME}/.cache/smithers/worktree-feature.db`, journalMode: "DELETE" });

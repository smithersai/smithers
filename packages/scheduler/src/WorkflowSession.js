import { Context } from "effect";
/** @typedef {import("./WorkflowSessionService.ts").WorkflowSessionService} WorkflowSessionService */

const WorkflowSessionBase =
  /** @type {Context.TagClass<WorkflowSession, "WorkflowSession", WorkflowSessionService>} */ (
    /** @type {unknown} */ (Context.Tag("WorkflowSession")())
  );

export class WorkflowSession extends WorkflowSessionBase {
}

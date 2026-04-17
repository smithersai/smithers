import { Layer } from "effect";
import { WorkflowSession } from "./WorkflowSession.js";
import { makeWorkflowSession } from "./makeWorkflowSession.js";

/** @type {Layer.Layer<WorkflowSession, never, never>} */
export const WorkflowSessionLive = Layer.sync(WorkflowSession, makeWorkflowSession);

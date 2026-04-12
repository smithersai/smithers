import { Layer } from "effect";
import { WorkflowSession } from "./WorkflowSession.js";
import { makeWorkflowSession } from "./makeWorkflowSession.js";
export const WorkflowSessionLive = Layer.sync(WorkflowSession, makeWorkflowSession);

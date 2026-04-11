import { Layer } from "effect";
import { WorkflowSession } from "./WorkflowSession.ts";
import { makeWorkflowSession } from "./makeWorkflowSession.ts";

export const WorkflowSessionLive = Layer.sync(WorkflowSession, makeWorkflowSession);

import { Context } from "effect";
import type { WorkflowSessionService } from "./WorkflowSessionService.ts";

export class WorkflowSession extends Context.Tag("WorkflowSession")<
  WorkflowSession,
  WorkflowSessionService
>() {}

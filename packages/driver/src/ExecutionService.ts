import { Context } from "effect";
import type { ExecutionServiceShape } from "./ExecutionServiceShape.ts";

export class ExecutionService extends Context.Tag("ExecutionService")<
  ExecutionService,
  ExecutionServiceShape
>() {}

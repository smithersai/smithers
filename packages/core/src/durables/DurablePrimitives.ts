import { Context } from "effect";
import type { DurablePrimitivesService } from "./DurablePrimitivesService.ts";

export class DurablePrimitives extends Context.Tag("DurablePrimitives")<
  DurablePrimitives,
  DurablePrimitivesService
>() {}

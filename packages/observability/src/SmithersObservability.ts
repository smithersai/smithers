import { Context } from "effect";
import type { SmithersObservabilityService } from "./SmithersObservabilityService";

export class SmithersObservability extends Context.Tag("SmithersObservability")<
  SmithersObservability,
  SmithersObservabilityService
>() {}

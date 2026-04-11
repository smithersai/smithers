import { FiberRef } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";

export const correlationContextFiberRef =
  FiberRef.unsafeMake<CorrelationContext | undefined>(undefined);

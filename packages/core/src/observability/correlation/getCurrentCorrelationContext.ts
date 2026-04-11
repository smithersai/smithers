import type { CorrelationContext } from "./CorrelationContext.ts";
import { correlationStorage } from "./_correlationStorage.ts";

export function getCurrentCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

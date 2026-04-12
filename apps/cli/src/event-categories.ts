import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export type SmithersEventType = SmithersEvent["type"];
export type EventCategory = "agent" | "approval" | "frame" | "memory" | "node" | "openapi" | "output" | "revert" | "run" | "sandbox" | "scorer" | "snapshot" | "supervisor" | "timer" | "token" | "tool-call" | "workflow";
export declare const EVENT_CATEGORY_VALUES: EventCategory[];
export declare function normalizeEventCategory(raw: string): EventCategory | null;
export declare function eventCategoryForType(type: string): EventCategory | null;
export declare function eventTypesForCategory(category: EventCategory): readonly SmithersEventType[];

import { FlowBinding } from "../../../../harness/src/index.ts";
import type { CalendarEvent, State, World } from "../../../character/world.vibe.platform.js";
export { call, load, tools, urlOf } from "../../../character/world.vibe.platform.js";
export type { Page, Patch, State, World, WorldData } from "../../../character/world.vibe.platform.js";
/** One recorded tool call. */
export interface Action {
    readonly tool: string;
    readonly input: Record<string, unknown>;
    /** What the tool answered. */
    output?: unknown;
}
/** A turn's mutable state before any tool ran: copies of the calendar and the issue list. */
export declare const initialState: (world: World, idBase?: number) => State;
/** The tool names a role holds in this world. */
export declare const grantedTo: (world: World, role: string) => ReadonlyArray<string>;
/**
 * Binds the role's granted tools as executable flows. Each call appends to
 * `actions` before it answers.
 */
export declare const sources: (world: World, role: string, actions: Array<Action>, 
/** Ids the tools mint (drafts, events, tasks) start after this, so turns of one conversation never reuse an id. */
idBase?: number) => Array<FlowBinding.Source>;
/** Calendar events after a run, for scorers that check a booking against the calendar. */
export declare const calendarOf: (world: World) => ReadonlyArray<CalendarEvent>;

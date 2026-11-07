import { Effect } from "effect";
import type * as FlowInvoker from "../src/FlowInvoker.vibe";
import type * as Route from "../src/Route.vibe";
export { invalidModule, recordedModule, refinedModule, specialModule, visibleModule } from "./modules.ts";
/** How many times the import-recording fixture has been evaluated. */
export { recordedImports } from "./modules.ts";
/**
 * The expected failure a program fails with; a success or a defect fails the
 * test. The program may need services that the enclosing block provides.
 */
export declare function failureOf<E, R>(program: Effect.Effect<unknown, E, R>): Effect.Effect<E, never, R>;
/** @throws {never} */
export declare const makeRoute: (name: string, sourcePath?: string, overrides?: Partial<Route.Route>) => Route.Route;
/**
 * An invoker that blocks until released, recording when the invocation starts
 * and when its interruption finalizer runs, so cancellation tests can observe
 * an in-flight fiber without real timers.
 * @throws {never}
 */
export declare const latchedInvoke: () => {
    invoke: FlowInvoker.FlowInvoker.Shape["invoke"];
    started: Promise<void>;
    finalized: Promise<void>;
    /** @throws {never} */
    release: () => void;
};

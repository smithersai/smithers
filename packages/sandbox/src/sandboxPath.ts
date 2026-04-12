import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
export declare function resolveSandboxPath(rootDir: string, inputPath: string): string;
export declare function assertPathWithinRootEffect(rootDir: string, resolvedPath: string): Effect.Effect<undefined, SmithersError, never>;
export declare function assertPathWithinRoot(rootDir: string, resolvedPath: string): Promise<undefined>;

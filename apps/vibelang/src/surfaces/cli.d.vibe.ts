import { Effect } from "effect";
import { Command } from "effect/cli";
export declare function cli(args: ReadonlyArray<string>, environment: string | undefined): Effect.Effect<0 | 1, never, Command.Environment>;

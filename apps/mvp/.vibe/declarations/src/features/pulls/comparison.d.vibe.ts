import type { Collection } from "@smthrs/effect-tanstack-db";
import { Effect, type Scope } from "effect";
import { PullsClient } from "./api.vibe";
import type { FilesRow } from "../../../../../src/features/pulls/schema.ts";
/**
 * Reads the files and commits `base` and `head` differ by into `rows` under `<base>...<head>`, once: a comparison of two
 * SHAs never changes, so a row held is kept and only a failed one is read again. The read runs in `scope`; two refs
 * that aren't both SHAs read nothing.
 */
export declare const readComparison: (rows: Collection.Collection<FilesRow, string>, scope: Scope.Scope, owner: string, name: string, base: string, head: string) => Effect.Effect<void, never, PullsClient>;

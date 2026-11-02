/**
 * Typed MDX prompt compilation. Compilation parses declarations without running
 * expressions; the verified module loader evaluates the resulting JavaScript.
 *
 * The MDX compiler loads the first time a prompt compiles, never when this
 * module does. A host that only runs flows, such as an agent in a browser's
 * dedicated worker, never loads it, and it must not: under the `browser`
 * export condition its Markdown parser calls `document` while it loads, and a
 * worker has no `document`.
 *
 * @since 1.0.0-rc.1
 */
import { Effect } from "effect";
import type * as Cause from "effect/Cause";
import type { Content as TextContent } from "../../../src/Prompt/jsx-runtime.ts";
/**
 * Content accepted by the text JSX runtime.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Content = TextContent;
/**
 * Declare the concrete props of each imported prompt in its companion declaration.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Component<Props> = (props: Props) => string;
/**
 * Compile MDX to an ESM module whose default export renders Markdown text.
 * Imported components and expressions run only when the resulting module runs.
 * Malformed MDX fails. The first call loads the MDX compiler.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const compile: (source: string) => Effect.Effect<string, Cause.UnknownError>;

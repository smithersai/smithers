/*
 * One spelling of a command name, for every boundary that matches one.
 *
 * The model, the composer, and the registry each meet a command name in a
 * different dialect: the catalog writes "/browser", the model copies that
 * slash, the human pads it with whitespace, and the registry's names are
 * bare. Execution (agentTools.ts, Commands.ts) normalizes before matching;
 * any classifier that reads the SAME arguments must normalize the same way,
 * or two spellings execution treats as one command get different guarantees
 * (RunClaims.ts: "/flow.run" launched a run but never armed the claim gate).
 */

/** The registry spelling of a command name: trimmed, leading slashes gone. */
export const canonicalCommandName = (name: string): string => name.trim().replace(/^\/+/, "")

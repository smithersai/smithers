import { Descriptor, ModuleFlow } from "@smthrs/registry"
import { Option } from "effect"
import { forbidden } from "./callable"
import { FLOW_MODEL_ROLE, MAX_CALLS, MAX_DESCRIPTION_CHARS, MAX_SOURCE_BYTES, NAME_PATTERN, RESERVED_NAMES } from "./contract"
import type { DraftCheck } from "./schema"
import { SOURCE_PATH } from "./source"

// Decision 0014's static checks over a person's flow source (./source.ts): every revision, drafted or written by hand,
// is read the one way the registry reads a repository's `flow.ts`, with @smthrs/registry's `ModuleFlow`, without
// importing it. Only an engine's host imports this module: the tab shows a draft's checks from its row.

/** What a flow's source declares, as the registry reads it. */
export interface Read {
  readonly tag: string | undefined
  readonly description: string | undefined
  readonly flows: ReadonlyArray<string> | undefined
  readonly model: string | ReadonlyArray<string> | undefined
  readonly placement: string | undefined
  readonly warnings: ReadonlyArray<string>
}

/** Reads `text`, the `flow.ts` of a flow named `name`. */
export const readSource = (text: string, name: string): Read => {
  const read = ModuleFlow.fromModule({
    text,
    path: `${name}/${SOURCE_PATH}`,
    naming: "frontmatter",
    name: Option.none(),
    dirBasename: name,
    provenance: new Descriptor.Provenance({ source: "person", root: "." }),
  })
  const descriptor = Option.getOrUndefined(read.descriptor)
  return {
    tag: Option.getOrUndefined(read.tag),
    description: descriptor?.description,
    flows: descriptor?.flows,
    model: descriptor === undefined ? undefined : Option.getOrUndefined(descriptor.model),
    placement: descriptor === undefined ? undefined : Option.getOrUndefined(descriptor.placement),
    warnings: read.warnings.map((warning) => warning.code),
  }
}

/**
 * Decision 0014's static checks over `text`, the source of a flow that should be named `name`, which may call only
 * `allowed` flows. Each check passes or names why it failed, by a code, never a quote of the file:
 * - `parses`: the registry reads a `Flow.make` default export without a warning;
 * - `name`: the tag `Flow.make` declares follows the pattern, stays outside the app's names, and is `name`;
 * - `description`: 1 to 1,024 characters;
 * - `calls`: its `flows` are at most `MAX_CALLS`, each one `allowed`, never a `flow/` or `run/` act;
 * - `model`: absent, or the endpoint's role `agent`, never a provider's model id; and no placement of its own, because
 *   where a person's flow runs is the host's to decide (./source.ts);
 * - `size`: 512 KiB at most.
 */
export const checkSource = (text: string, name: string, allowed: ReadonlyArray<string>): ReadonlyArray<DraftCheck> => {
  const read = readSource(text, name)
  const check = (id: DraftCheck["check"], failure: string | undefined): DraftCheck =>
    failure === undefined ? { check: id, ok: true } : { check: id, ok: false, code: failure }
  return [
    check("parses", read.warnings[0]),
    check(
      "name",
      read.tag === undefined || !NAME_PATTERN.test(read.tag)
        ? "pattern"
        : (RESERVED_NAMES as ReadonlyArray<string>).includes(read.tag)
        ? "reserved"
        : read.tag !== name
        ? "mismatch"
        : undefined,
    ),
    check(
      "description",
      read.description === undefined || read.description.trim() === "" ||
        [...read.description].length > MAX_DESCRIPTION_CHARS
        ? "length"
        : undefined,
    ),
    check(
      "calls",
      read.flows === undefined
        ? "unread"
        : read.flows.length > MAX_CALLS
        ? "too_many"
        : read.flows.some(forbidden)
        ? "forbidden"
        : read.flows.some((flow) => !allowed.includes(flow))
        ? "unknown"
        : undefined,
    ),
    check(
      "model",
      read.model !== undefined && read.model !== FLOW_MODEL_ROLE
        ? "model"
        : read.placement !== undefined
        ? "placement"
        : undefined,
    ),
    check("size", new TextEncoder().encode(text).length > MAX_SOURCE_BYTES ? "too_large" : undefined),
  ]
}

/** Whether every check passed. */
export const passes = (checks: ReadonlyArray<DraftCheck>): boolean => checks.every((check) => check.ok)

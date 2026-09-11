/**
 * The complete paged flow catalog, read the same way by `ls` and `doctor`.
 *
 * @since 1.0.0
 */
import { ControlSchema } from "@smthrs/control"
import type { Service as ControlServiceShape } from "@smthrs/control/Control"
import { Effect } from "effect"
import * as CliError from "../CliError.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"

/**
 * One page of the flow listing.
 * @category models
 * @since 1.0.0
 */
export type FlowPage = Extract<ControlSchema.ListResponse, { readonly _tag: "flows" }>

/**
 * Every page, bounded by the history limits so a runaway registry cannot
 * exhaust the process.
 * @category constructors
 * @since 1.0.0
 */
export const read = (control: ControlServiceShape) =>
  Effect.gen(function*() {
    const items: Array<FlowPage["items"][number]> = []
    const warnings: Array<NonNullable<FlowPage["warnings"]>[number]> = []
    const warningKeys = new Set<string>()
    const cursors = new Set<string>()
    let bytes = 0
    let cursor: string | undefined
    for (;;) {
      const listed = yield* control.list({
        _tag: "flows",
        limit: ControlSchema.maxPageSize,
        ...(cursor === undefined ? {} : { cursor })
      })
      if (listed._tag !== "flows") {
        return yield* Effect.fail(
          new CliError.UnsupportedError({ message: "the control plane returned a run page for a flow listing" })
        )
      }
      for (const item of listed.items) {
        bytes += BoundedEvents.encodedBytes(item)
        if (items.length >= BoundedEvents.maximumEvents || bytes > BoundedEvents.maximumBytes) {
          return yield* Effect.fail(
            new CliError.ResourceLimitError({
              operation: "flow listing",
              subject: "the discovered registry",
              limit: bytes > BoundedEvents.maximumBytes ? BoundedEvents.maximumBytes : BoundedEvents.maximumEvents,
              unit: bytes > BoundedEvents.maximumBytes ? "bytes" : "events"
            })
          )
        }
        items.push(item)
      }
      for (const warning of listed.warnings ?? []) {
        const key = `${warning.code}\0${warning.path}\0${warning.message}`
        if (!warningKeys.has(key)) {
          warningKeys.add(key)
          warnings.push(warning)
        }
      }
      if (listed.nextCursor === undefined) break
      if (cursors.has(listed.nextCursor)) {
        return yield* Effect.fail(
          new CliError.UnsupportedError({ message: "the control plane repeated a flow-listing cursor" })
        )
      }
      cursors.add(listed.nextCursor)
      cursor = listed.nextCursor
    }
    return { items, warnings }
  })

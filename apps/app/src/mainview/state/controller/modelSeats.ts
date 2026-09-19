import { bindingOf,modelSeat } from "@smthrs/rpc/ConfiguredModel"
import type { ConfiguredModel,ModelBinding,SeatId } from "@smthrs/rpc/ConfiguredModel"
import type { ControllerContext } from "./context"
import { resolvedSeats } from "./models"

/*
 * The one reader every seat consumer shares (explain, turns, recommend): what
 * a request rides on is read here, at call time, and nowhere else. An
 * unassigned seat, an assignment whose record is gone or of the wrong kind
 * (models.ts resolvedSeats), and a seat this host does not serve all read as
 * undefined, and an undefined seat changes nothing about the request.
 */

type SeatContext = Pick<ControllerContext, "store" | "services">

/** The record assigned to a seat this host serves. A host that has not said what it is decides for itself. */
export const assignedModel = (ctx: SeatContext, seat: SeatId): ConfiguredModel | undefined => {
  const host = ctx.services.bootstrap?.host
  if (host !== undefined && !modelSeat(seat).hosts.includes(host)) return undefined
  return resolvedSeats(ctx.store).find((row) => row.seat === seat)?.model
}

/** What the seat's request carries: the record without its name, never a key. */
export const assignedBinding = (ctx: SeatContext, seat: SeatId): ModelBinding | undefined => {
  const model = assignedModel(ctx, seat)
  return model === undefined ? undefined : bindingOf(model)
}

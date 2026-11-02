import { Context, type Effect, Schema } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Access } from "../../src/features/branch/contract.ts"
import type { Role } from "../Actor.ts"
import type { Admission } from "../SocketAccess.ts"
import type { Policy } from "./Access.ts"

// A branch's room as the routes reach it (decision 0013 §4, docs/features/branch-workspace.md#presence): who is on the
// branch and where, live, through one hibernating room per branch that stores nothing. On Cloudflare it is the
// branch's `RoomObject` Durable Object (worker/BranchRooms.ts); a test provides its own. Nothing here names a host.

/** Who joins a room, as ChatApi decided it: the person, their login, their role and what they may do on the branch. */
export interface Member {
  readonly principal: string
  readonly name: string
  readonly role: Role | null
  readonly access: Access
  /** Who ChatApi admitted, which the room rechecks while the socket stays open (worker/SocketAccess.ts). */
  readonly admission: Admission
}

/** The room couldn't be reached to apply a change of access. The change stands; applying it again is safe. */
export class RoomUnavailable extends Schema.TaggedError<RoomUnavailable>()("@smthrs/mvp/branch/RoomUnavailable", {}) {}

/** The rooms of every branch, by branch id. */
export class Rooms extends Context.Service<
  Rooms,
  {
    /** Joins the request's socket to the branch's room: the host's answer to the upgrade. */
    readonly join: (
      branchId: string,
      member: Member,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
    /**
     * Applies the branch's permission list to everyone in its room: anyone who may no longer view it leaves for good
     * (close 1008), and anyone whose access changed reconnects to get the new one. Doing it again changes nothing.
     */
    readonly enforce: (branchId: string, policy: Policy) => Effect.Effect<void, RoomUnavailable>
  }
>()("@smthrs/mvp/branch/Rooms") {}

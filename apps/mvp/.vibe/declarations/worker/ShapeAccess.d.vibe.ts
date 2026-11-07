import { ShapeProxy } from "@smthrs/effect-electric";
import { Effect, Option } from "effect";
import { Sessions } from "./Actor.vibe";
/** How long a device waits before asking again, in seconds; its own sync policy may wait longer. */
export declare const RETRY_AFTER_SECONDS = 5;
/** The refusal of a shape request the server can't decide right now. */
export declare const unavailable: ShapeProxy.Refused;
/** Who is asking for a shape: signed out is none; a session store that can't answer is `unavailable`. */
export declare const actor: Effect.Effect<Option.Option<import("./Actor.vibe").Actor>, ShapeProxy.Refused, import("effect/http/HttpServerRequest").HttpServerRequest | Sessions>;
/** Admin-only shapes are refused before Electric is contacted; unreadable sessions still answer 503. */
export declare const admin: Effect.Effect<void, ShapeProxy.Refused, import("effect/http/HttpServerRequest").HttpServerRequest | Sessions>;

import { Effect, Metric } from "effect";
/** `GET /api/shapes/spend-alerts` requests, by `status` and `live`. */
export declare const shapes: Metric.Counter<number>;
/**
 * Reads Electric's connection (`ShapeProxy.config`) and returns `GET /api/shapes/spend-alerts`: every alert for a
 * person with the Admin role; signed out, or any other role, 403; sessions unreadable, 503
 * (worker/ShapeAccess.ts). Each request is a `spend.alerts.shape` line and a count.
 */
export declare const make: Effect.Effect<Effect.Effect<import("effect/http/HttpServerResponse").HttpServerResponse, never, import("effect/http/HttpClient").HttpClient | import("effect/http/HttpServerRequest").HttpServerRequest | import("./Actor.vibe").Sessions>, import("effect/Config").ConfigError, never>;

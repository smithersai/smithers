import type { HttpServerRequest } from "effect/http";
/** Whether the request asks to upgrade to a WebSocket. */
export declare const isUpgrade: (request: HttpServerRequest.HttpServerRequest) => boolean;
/** Whether the request came from a page of this app: its `Origin` is the request's own. */
export declare const sameOrigin: (request: HttpServerRequest.HttpServerRequest) => boolean;

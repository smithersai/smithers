import { Metric } from "effect";
/** `POST /api/questions` requests, by HTTP `status`. */
export declare const questions: Metric.Counter<number>;
/** `GET /api/shapes/messages` requests, by HTTP `status` and `live` (`true` or `false`). */
export declare const shapes: Metric.Counter<number>;

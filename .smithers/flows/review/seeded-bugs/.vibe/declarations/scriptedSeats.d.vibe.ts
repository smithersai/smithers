import * as SeatResolver from "../../../../../../packages/smithers/agent/src/SeatResolver.ts";
import * as Model from "../../../../../../packages/smithers/agent/model/src/Model.vibe";
import { Layer } from "effect";
/** What the scripted model was asked, flattened into one searchable string. */
export type Ask = string;
/**
 * A model that answers each call with one fenced `cell` block carrying the
 * value `answer` returns for what it was asked.
 *
 * `answer` returning `undefined` makes the model refuse the way a provider
 * error does, which is how a test drives the caught-failure paths.
 */
export declare function scriptedModel(answer: (ask: Ask) => unknown): Model.Model;
/** Resolves every declared seat to one scripted model. */
export declare function scriptedSeats(answer: (ask: Ask) => unknown): Layer.Layer<SeatResolver.SeatResolver>;

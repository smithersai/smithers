import { type ShapeSource } from "@smthrs/effect-electric";
import type { Collection } from "@smthrs/effect-tanstack-db";
import { type PullsView } from "../../../../../src/features/pulls/schema.ts";
/** Detail shapes carry their routed subject; only a matching, newer server receipt can certify its absence. */
export declare const refreshingSource: (source: ShapeSource.Source, view: Collection.Collection<PullsView, string>, id: string) => ShapeSource.Source;

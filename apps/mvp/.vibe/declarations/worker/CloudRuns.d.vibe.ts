import type { Flow } from "@smthrs/flow";
import { EngineStore } from "@smthrs/flows";
import { Effect, Layer, Metric } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { type Actor, Sessions } from "./Actor.vibe";
import * as RepoRoles from "../../../worker/github/RepoRoles.ts";
/** The deployment's own flows an Admin sees, each read through its declaration. */
export declare const SYSTEM_FLOWS: ReadonlyArray<Flow.Any>;
/** Their tags. */
export declare const SYSTEM_FLOW_TAGS: ReadonlyArray<string>;
/** Reads of the Cloud runs list, by `outcome` (`read`, `partial`, or a refusal's code). */
export declare const lists: Metric.Counter<number>;
/** The most repositories one read resolves a role on; older repositories' runs wait for the next read. */
export declare const MAX_REPOSITORIES = 8;
/**
 * The runs on Cloudflare `actor` may read, newest first, at most `limit`. A repository whose role can't be resolved
 * now leaves its runs out and marks the read `partial`; the list still answers.
 */
export declare const read: <E, R, EE, ER>(actor: Actor, limit: number, options: {
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>;
    readonly engine: Layer.Layer<SqlClient.SqlClient, EE, ER>;
    readonly inspection: Layer.Layer<EngineStore.RunInspection.RunInspection, never, SqlClient.SqlClient>;
    readonly roles: RepoRoles.RepoRoles<R>;
}) => Effect.Effect<{
    runs: {
        readonly runId: string;
        readonly flow: string;
        readonly kind: "repo" | "system" | "todo";
        readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
        readonly cancelRequested: boolean;
        readonly createdAtMs: number;
        readonly startedAtMs: number | null;
        readonly finishedAtMs: number | null;
        readonly trigger: "commit" | "manual" | "pull_request" | "push" | "retry" | "system";
        readonly branch: string | null;
        readonly actor: string | null;
        readonly repo: string | null;
    }[];
    partial: boolean;
    counts: {
        todo: number;
        repo: number;
        system: number;
    };
}, E | EE | import("@smthrs/run-store/RunStore").RunStoreError | import("effect/sql/SqlError").SqlError, ER | Exclude<R, EngineStore.RunInspection.RunInspection> | Exclude<Exclude<R, SqlClient.SqlClient>, EngineStore.RunInspection.RunInspection>>;
/** `GET /api/cloud-runs?limit=<n>`: the runs on Cloudflare the asker may read, newest first. */
export declare const route: <E, R, EE, ER>(options: Parameters<typeof read<E, R, EE, ER>>[2]) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Sessions | Exclude<ER, import("effect/Tracer").ParentSpan> | Exclude<Exclude<R, EngineStore.RunInspection.RunInspection>, import("effect/Tracer").ParentSpan>>;

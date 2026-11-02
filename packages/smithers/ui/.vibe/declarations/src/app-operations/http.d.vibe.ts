import { Schema } from "effect";
/** HTTP projections use the same literal Operation catalog as interactive acts.
 * They expose no additional slash, CLI or model door. Concrete control bodies
 * must resolve their operation before authorization; there is no control grant.
 */
import { type OperationPayload } from "../../../../src/app-operations/index.ts";
export declare const httpProjections: readonly [Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "workspace.services.list";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "List private branch services";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/repos/{owner}/{repo}/workspaces/{id}/services";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "read:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "workspace.command.read";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Read command result";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/repos/{owner}/{repo}/workspaces/{id}/command-runs/{operationID}";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "read:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "devtools.write";
    readonly input: Schema.Struct<{
        readonly session_id: Schema.String;
        readonly kind: Schema.String;
        readonly repository_id: Schema.optional<Schema.Union<readonly [Schema.Number, Schema.Null]>>;
        readonly workspace_id: Schema.optional<Schema.Union<readonly [Schema.String, Schema.Null]>>;
        readonly payload: Schema.$Record<Schema.String, Schema.Unknown>;
    }>;
    readonly summary: "Save a private snapshot";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/repos/{owner}/{repo}/devtools/snapshots";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "devtools.read";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Read private snapshots";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/repos/{owner}/{repo}/devtools/snapshots";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "read:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "landings.read";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Read recorded review data";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/repos/{owner}/{repo}/landings";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "runs.cancel";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Stop run";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/repos/{owner}/{repo}/runs/{id}/cancel";
    };
    readonly minimumRole: "member";
    readonly agent: "confirm";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "account.oauth.revoke";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Revoke app access";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/oauth2/revoke-all";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["external_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:user";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "github.account-review";
    readonly input: Schema.Struct<{
        readonly event: Schema.Literals<readonly ["APPROVE", "REQUEST_CHANGES", "COMMENT"]>;
        readonly body: Schema.String;
        readonly commit_id: Schema.String;
    }>;
    readonly summary: "github.account-review";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/user/github-repos/{owner}/{repo}/pulls/{number}/reviews";
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
        readonly path: string;
    };
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository" | "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: OperationPayload;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST";
        readonly path: string;
    };
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly credentialScope: "read:workspace" | "write:repository" | "write:workspace";
    readonly actors: readonly [];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "flow.source-coedit";
    readonly summary: "Edit source";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly input: Schema.Struct<{
        readonly changes: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly base_digest: Schema.String;
            readonly content: Schema.Union<readonly [Schema.String, Schema.Null]>;
            readonly encoding: Schema.optional<Schema.Literals<readonly ["utf-8", "base64"]>>;
        }>>;
    }>;
    readonly http: {
        readonly method: "PUT";
        readonly path: "/api/repos/{owner}/{repo}/workspaces/{id}/files/content";
    };
    readonly minimumRole: "member";
    readonly agent: "run";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person", "external_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "branch.sleep" | "branch.wake";
    readonly input: Schema.Struct<{
        readonly branch: Schema.String;
    }>;
    readonly summary: "Sleep branch" | "Wake branch";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly agent: "never";
    readonly actors: readonly ["person"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/branches/{branch}";
        readonly defaults: {
            readonly op: "sleep" | "wake";
        };
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "branch.sleep" | "branch.wake";
    readonly input: Schema.Struct<{
        readonly branch: Schema.String;
    }>;
    readonly summary: "Sleep branch" | "Wake branch";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly agent: "never";
    readonly actors: readonly ["person"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/branches/{branch}";
        readonly defaults: {
            readonly op: "sleep" | "wake";
        };
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "external.read";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "external.read";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly minimumRole: "owner";
    readonly agent: "never";
    readonly credentialScope: "read:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: string;
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: string;
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET";
        readonly path: string;
    };
    readonly minimumRole: "member" | "owner";
    readonly agent: "never" | "run";
    readonly credentialScope: "read:repository" | "read:user";
    readonly actors: ("app_agent" | "external_agent" | "person")[];
} & {
    readonly agent: "run" | "confirm" | "never";
}, ...(Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "secrets.delete" | "secrets.scope" | "secrets.set";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Change secret";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        method: "DELETE" | "PATCH" | "POST";
        path: "/api/secrets" | "/api/secrets/{name}";
    };
    readonly minimumRole: "maintainer";
    readonly agent: "never";
    readonly credentialScope: "write:repository";
    readonly actors: readonly ["person"];
} & {
    readonly agent: "run" | "confirm" | "never";
})[], Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "summary" | "visibility"> & {
    readonly name: "agent.turn";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Ask agent";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly agent: "run";
    readonly credentialScope: "read:user";
    readonly actors: readonly ["person", "app_agent", "external_agent"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/conversations/{id}/prompt";
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "credentialScope" | "hidden" | "http" | "input" | "minimumRole" | "name" | "summary" | "visibility"> & {
    readonly name: "telemetry.report";
    readonly credentialScope: "read:user";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Report error";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly agent: "run";
    readonly actors: readonly ["person", "app_agent", "external_agent"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/telemetry/errors";
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}, Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "hidden" | "http" | "input" | "minimumRole" | "name" | "summary" | "visibility"> & {
    readonly name: "sync.retry";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
    readonly summary: "Retry sync";
    readonly hidden: true;
    readonly visibility: "hidden";
    readonly agent: "run";
    readonly actors: readonly ["person", "app_agent"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "POST";
        readonly path: "/api/github/sync";
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}];

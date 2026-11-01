import { Schema } from "effect";
export declare const pendingControls: readonly [Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "todo.preapprove";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "todo.unapprove";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "todo.return-to-item";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
        readonly id: Schema.optional<Schema.NonEmptyString>;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "todo.keep-moved";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
        readonly id: Schema.optional<Schema.NonEmptyString>;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "branch.bring-in";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly branch: Schema.NonEmptyString;
        readonly id: Schema.NonEmptyString;
        readonly revision: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "branch.discard-foreign";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly branch: Schema.NonEmptyString;
        readonly id: Schema.NonEmptyString;
        readonly revision: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "branch.rebase-now";
    readonly summary: "Rebase now";
    readonly input: Schema.Struct<{
        readonly branch: Schema.NonEmptyString;
    }>;
    readonly agent: "run";
    readonly hidden: false;
    readonly minimumRole: "member";
    readonly visibility: "core";
    readonly slash: "/rebase";
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly ["J7"];
    readonly group: "Branches and machines";
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "learning.accept";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "learning.dismiss";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "todo.takeover";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "merge.confirm";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly n: Schema.Int;
        readonly revision: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "order.ok";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
        readonly revision: Schema.Int;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "main.reset-to-github";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
        readonly old: Schema.String;
        readonly new: Schema.String;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
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
}, "actors" | "agent" | "cli" | "group" | "hidden" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "settings.model.set";
    readonly summary: string;
    readonly input: Schema.Struct<{
        readonly role: Schema.Literals<readonly ["fast", "coding", "jev"]>;
        readonly model: Schema.NonEmptyString;
    }>;
    readonly agent: "confirm" | "never" | "run";
    readonly hidden: true;
    readonly minimumRole: "maintainer" | "member" | "owner";
    readonly visibility: "in-card";
    readonly slash: null;
    readonly cli: null;
    readonly http: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    readonly journey: readonly [];
    readonly group: "";
    readonly actors: readonly ["person"] | readonly ["person", "app_agent"];
} & {
    readonly agent: "run" | "confirm" | "never";
}];

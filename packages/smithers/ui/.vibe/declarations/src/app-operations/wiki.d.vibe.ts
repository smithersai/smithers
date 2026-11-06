import { Schema } from "effect";
/** The product name of Smithers' understanding of a repository. */
export declare const WIKI_DISPLAY_NAME = "Wiki";
/** Why `wiki.heading` is the human's alone: it scrolls their editor, which is focus. */
export declare const WIKI_HEADING_USER_ONLY_REASON = "scrolling the open note's editor to a heading is the human's viewport gesture; the agent reads a note with wiki.open";
/** Why `wiki.attach` is the human's alone: the file comes from their own file dialog. */
export declare const WIKI_ATTACH_USER_ONLY_REASON = "the file comes from the human's own file dialog; a model has no file to give";
/** Why `wiki.ask` is the human's alone: the question is their turn, as the composer is. */
export declare const WIKI_ASK_USER_ONLY_REASON = "the question is the human's turn; the model is already the turn, and asking would nest one \u2014 it reads a page with wiki.open";
/** The bare `wiki` surface switch, registered first with the other top-level surfaces. */
export declare const wikiSurfaceOperations: readonly [Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "cli" | "form" | "grammar" | "group" | "http" | "input" | "journey" | "minimumRole" | "name" | "slash" | "summary" | "visibility"> & {
    readonly name: "wiki";
    readonly slash: "/wiki";
    readonly cli: readonly ["wiki", "show"];
    readonly journey: readonly ["J8"];
    readonly group: "Wiki";
    readonly visibility: "core";
    readonly actors: readonly ["person", "app_agent", "external_agent"];
    readonly minimumRole: "member";
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/repos/{owner}/{repo}/wiki";
        readonly query: {};
    };
    readonly summary: "Open the wiki";
    readonly agent: "run";
    readonly input: Schema.Struct<{
        readonly operation: Schema.optional<Schema.Literal<"proposal">>;
        readonly id: Schema.optional<Schema.NonEmptyString>;
        readonly owner: Schema.optional<Schema.NonEmptyString>;
        readonly repo: Schema.optional<Schema.NonEmptyString>;
    }>;
    readonly grammar: (args?: string) => {
        payload: any;
        error?: undefined;
    } | {
        payload?: undefined;
        error: string;
    };
    readonly form: {
        readonly fields: {
            readonly operation: {
                readonly hidden: true;
            };
            readonly id: {
                readonly hidden: true;
            };
            readonly owner: {
                readonly hidden: true;
            };
            readonly repo: {
                readonly hidden: true;
            };
        };
        readonly args: (payload: Readonly<Record<string, unknown>>) => string;
    };
} & {
    readonly agent: "run" | "confirm" | "never";
}];
/** The `wiki.*` operations: notes, repository Wiki pages and their confirmations. */
export declare const wikiOperations: readonly [Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "agent" | "agentReason" | "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.ask";
    readonly summary: "Ask the codebase a question; the answer cites the Wiki";
    readonly agent: "never";
    readonly agentReason: "the question is the human's turn; the model is already the turn, and asking would nest one — it reads a page with wiki.open";
    readonly args: "<question>";
    readonly form: {
        readonly submitLabel: "Ask";
        readonly fields: {
            readonly question: {
                readonly label: "Question";
            };
        };
    };
    readonly input: Schema.Struct<{
        readonly question: Schema.String;
    }>;
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
}, "args" | "confirm" | "form" | "input" | "name" | "requires" | "summary"> & {
    readonly name: "wiki.create";
    readonly summary: "Refresh the repository Wiki in the background";
    readonly args: "<owner/repo>";
    readonly requires: readonly ["signed-in"];
    readonly confirm: "refresh the repository Wiki";
    readonly input: Schema.Struct<{
        readonly repo: Schema.NonEmptyString;
    }>;
    readonly form: {
        readonly fields: {
            readonly repo: {
                readonly optionsFrom: "cloud-repos";
                readonly kind: "text";
                readonly label: "Repository";
            };
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
}, "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.cloud";
    readonly summary: "Browse the repository Wiki";
    readonly args: "<owner/repo> [page] [--space public|private]";
    readonly input: Schema.Struct<{
        readonly repo: Schema.String;
        readonly page: Schema.optional<Schema.Number>;
        readonly space: Schema.optional<Schema.Literals<readonly ["public", "private"]>>;
    }>;
    readonly form: {
        readonly fields: {
            readonly repo: {
                readonly optionsFrom: "cloud-repos";
                readonly kind: "text";
            };
            readonly space: {
                readonly hidden: true;
            };
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
}, "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.cloud.open";
    readonly summary: "Open a collaborative repository Wiki page in the conversation";
    readonly args: "<slug> <owner/repo> [--space public|private]";
    readonly input: Schema.Struct<{
        readonly slug: Schema.String;
        readonly repo: Schema.String;
        readonly space: Schema.optional<Schema.Literals<readonly ["public", "private"]>>;
    }>;
    readonly form: {
        readonly fields: {
            readonly space: {
                readonly hidden: true;
            };
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
}, "args" | "input" | "name" | "summary"> & {
    readonly name: "wiki.sync";
    readonly summary: "Refresh a cloud Wiki page and retry its saved edits";
    readonly args: "<documentId>";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
    }>;
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
}, "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.edit";
    readonly summary: "Edit a Wiki page as Markdown";
    readonly args: "<documentId> <JSON Markdown string>";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
        readonly body: Schema.String;
    }>;
    readonly form: {
        readonly fields: {
            readonly body: {
                readonly label: "Markdown";
            };
        };
        readonly args: (payload: Readonly<Record<string, unknown>>) => string;
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
}, "args" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.card.select";
    readonly summary: "Select a page in an embedded Wiki card";
    readonly hidden: true;
    readonly args: "<cardId> <documentId>";
    readonly input: Schema.Struct<{
        readonly cardId: Schema.String;
        readonly documentId: Schema.String;
    }>;
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
}, "args" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.card.view";
    readonly summary: "Show a Wiki page outline or its Markdown document";
    readonly hidden: true;
    readonly args: "<cardId> <outline|read|document>";
    readonly input: Schema.Struct<{
        readonly cardId: Schema.String;
        readonly view: Schema.Literals<readonly ["outline", "read", "document"]>;
    }>;
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
}, "input" | "name" | "summary"> & {
    readonly name: "wiki.new-note";
    readonly summary: "Create a Wiki note";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
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
}, "args" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.select";
    readonly summary: "Open a Wiki note";
    readonly hidden: true;
    readonly args: "<documentId>";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
    }>;
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
}, "args" | "input" | "name" | "summary"> & {
    readonly name: "wiki.open";
    readonly summary: "Open a Wiki note by path or title";
    readonly args: "<path>";
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
    }>;
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
}, "args" | "input" | "name" | "summary"> & {
    readonly name: "wiki.backlinks";
    readonly summary: "Notes that link to a note, and where it links out";
    readonly args: "<path>";
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
    }>;
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
}, "args" | "input" | "name" | "summary"> & {
    readonly name: "wiki.graph";
    readonly summary: "The Wiki link graph, whole or around one note";
    readonly args: "[path]";
    readonly input: Schema.Struct<{
        readonly path: Schema.optional<Schema.String>;
    }>;
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
}, "agent" | "agentReason" | "args" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.heading";
    readonly summary: "Scroll the open note to a heading";
    readonly hidden: true;
    readonly agent: "never";
    readonly agentReason: "scrolling the open note's editor to a heading is the human's viewport gesture; the agent reads a note with wiki.open";
    readonly args: "<line> [cardId]";
    readonly input: Schema.Struct<{
        readonly line: Schema.String;
        readonly cardId: Schema.optional<Schema.String>;
    }>;
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
}, "agent" | "args" | "http" | "input" | "name" | "summary" | "visibility"> & {
    readonly name: "wiki.delete";
    readonly visibility: "in-card";
    readonly summary: "Delete a Wiki note";
    readonly agent: "confirm";
    readonly http: {
        readonly method: "DELETE";
        readonly path: "/api/repos/{owner}/{repo}/wiki/{documentId}";
        readonly query: {
            readonly visibility: "visibility";
        };
    };
    readonly args: "<documentId>";
    readonly input: Schema.Struct<{
        readonly documentId: Schema.String;
        readonly owner: Schema.optional<Schema.String>;
        readonly repo: Schema.optional<Schema.String>;
        readonly visibility: Schema.optional<Schema.Literals<readonly ["public", "private"]>>;
    }>;
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
}, "agent" | "agentReason" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.delete.confirm";
    readonly summary: "Delete the note Smithers asked about";
    readonly hidden: true;
    readonly agent: "never";
    readonly agentReason: "a confirm-dialog answer is the human's";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
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
}, "agent" | "agentReason" | "hidden" | "input" | "name" | "summary"> & {
    readonly name: "wiki.delete.cancel";
    readonly summary: "Keep the note Smithers asked about";
    readonly hidden: true;
    readonly agent: "never";
    readonly agentReason: "a confirm-dialog answer is the human's";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
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
}, "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.space";
    readonly summary: "Show the public or the private part of the repository Wiki";
    readonly args: "public|private [owner/repo]";
    readonly input: Schema.Struct<{
        readonly space: Schema.Literals<readonly ["public", "private"]>;
        readonly repo: Schema.optional<Schema.String>;
    }>;
    readonly form: {
        readonly fields: {
            readonly repo: {
                readonly hidden: true;
            };
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
}, "args" | "input" | "name" | "summary"> & {
    readonly name: "wiki.view";
    readonly summary: "Show the Wiki page rendered, or its editor";
    readonly args: "read|edit";
    readonly input: Schema.Struct<{
        readonly view: Schema.Literals<readonly ["read", "edit"]>;
    }>;
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
}, "args" | "form" | "input" | "name" | "requires" | "summary"> & {
    readonly name: "wiki.cloud.new";
    readonly summary: "Create a page in the repository Wiki";
    readonly args: "<title> [owner/repo]";
    readonly requires: readonly ["signed-in"];
    readonly input: Schema.Struct<{
        readonly title: Schema.String;
        readonly repo: Schema.optional<Schema.String>;
    }>;
    readonly form: {
        readonly submitLabel: "Create";
        readonly fields: {
            readonly title: {
                readonly label: "Title";
            };
            readonly repo: {
                readonly hidden: true;
            };
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
}, "args" | "form" | "input" | "name" | "requires" | "summary"> & {
    readonly name: "wiki.cloud.rename";
    readonly summary: "Move a Wiki page to another path";
    readonly args: "<slug> <path> [owner/repo]";
    readonly requires: readonly ["signed-in"];
    readonly input: Schema.Struct<{
        readonly slug: Schema.optional<Schema.String>;
        readonly path: Schema.String;
        readonly repo: Schema.optional<Schema.String>;
    }>;
    readonly form: {
        readonly submitLabel: "Rename";
        readonly fields: {
            readonly slug: {
                readonly hidden: true;
            };
            readonly path: {
                readonly label: "Path";
                readonly placeholder: "Guides/Start.md";
            };
            readonly repo: {
                readonly hidden: true;
            };
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
}, "args" | "confirm" | "input" | "name" | "requires" | "summary"> & {
    readonly name: "wiki.cloud.delete";
    readonly summary: "Delete a Wiki page; its history stays";
    readonly args: "<slug> [owner/repo]";
    readonly requires: readonly ["signed-in"];
    readonly confirm: "delete the Wiki page";
    readonly input: Schema.Struct<{
        readonly slug: Schema.String;
        readonly repo: Schema.optional<Schema.String>;
    }>;
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
}, "args" | "form" | "input" | "name" | "summary"> & {
    readonly name: "wiki.history";
    readonly summary: "Show a Wiki page's history: every revision, renames and the deletion included";
    readonly args: "<slug> [owner/repo] [--space public|private]";
    readonly input: Schema.Struct<{
        readonly slug: Schema.String;
        readonly repo: Schema.optional<Schema.String>;
        readonly page: Schema.optional<Schema.Number>;
        readonly space: Schema.optional<Schema.Literals<readonly ["public", "private"]>>;
    }>;
    readonly form: {
        readonly fields: {
            readonly repo: {
                readonly hidden: true;
            };
            readonly page: {
                readonly hidden: true;
            };
            readonly space: {
                readonly hidden: true;
            };
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
}, "agent" | "agentReason" | "args" | "input" | "name" | "requires" | "summary"> & {
    readonly name: "wiki.attach";
    readonly summary: "Attach a file to the repository Wiki";
    readonly agent: "never";
    readonly agentReason: "the file comes from the human's own file dialog; a model has no file to give";
    readonly args: "[path] [owner/repo]";
    readonly requires: readonly ["signed-in"];
    readonly input: Schema.Struct<{
        readonly path: Schema.optional<Schema.String>;
        readonly repo: Schema.optional<Schema.String>;
    }>;
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
}, "agent" | "agentReason" | "input" | "name" | "summary"> & {
    readonly name: "wiki.pane";
    readonly summary: "Open the Wiki beside the chat";
    readonly agent: "never";
    readonly agentReason: "a surface switch; the model reads the wiki with wiki and wiki.cloud, which answer as embedded cards";
    readonly input: Schema.$Record<Schema.String, Schema.Never>;
} & {
    readonly agent: "run" | "confirm" | "never";
}];

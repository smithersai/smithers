/**
 * The messages a tab and the engine's leader exchange over the app
 * database's `BroadcastChannel`, `<name>/sql`: a channel of its own, so the
 * engine's tabs never decode rows meant for another tab.
 *
 * - A tab posts `Execute` under its own client id and a request number, one
 *   request at a time; only the leader answers, with `Executed` or `Failed`
 *   addressed to that client and number.
 * - A request with `batch` runs each of its statements in order, as one
 *   request, and `Executed` answers each one's rows in `results`. Its `sql`
 *   is {@link batchSql}, which an older leader that does not know `batch`
 *   runs instead, returning no rows and no `results`, so the tab knows to send
 *   the statements one at a time.
 * - `transaction` names the leader that holds the tab's open transaction, and
 *   `opened` the request that opened it. A statement for a transaction
 *   another leader held is never run outside it: the new leader answers it as
 *   committed when the old one committed the transaction with it, and refuses
 *   it otherwise, so the tab runs the transaction again.
 * - A worker that starts serving posts `Ready`, and every tab posts its
 *   unanswered request again. A leader runs each request once. Every change a
 *   request commits carries its receipt ({@link commits}), so a new leader
 *   answers a request the old one committed as committed, with the rows it
 *   returned ({@link replies}), and never runs it again.
 *
 * Rows, parameters and SQLite's own messages travel in the replies; none is
 * ever logged.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * One statement of a batch: `sql` with `params`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Statement: Schema.Struct<{
    readonly sql: Schema.String;
    readonly params: Schema.$Array<Schema.Unknown>;
}>;
/**
 * What a batch request's `sql` says: nothing, so an older leader that runs it
 * instead of `batch` changes nothing and returns no rows.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const batchSql = "SELECT 1 WHERE 0";
/**
 * Run `sql` with `params` for `client`, or each of `batch` in order, as one
 * request. `opened` is set with `transaction`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Execute: Schema.TaggedStruct<"Execute", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly sql: Schema.String;
    readonly params: Schema.$Array<Schema.Unknown>;
    readonly transaction: Schema.NullOr<Schema.String>;
    readonly opened: Schema.optional<Schema.Number>;
    readonly batch: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly sql: Schema.String;
        readonly params: Schema.$Array<Schema.Unknown>;
    }>>>;
}>;
/**
 * The leader ran the statement. `leader` names the leader; `open` says
 * whether the statement left the client's transaction open. A batch's reply
 * carries each statement's rows in `results`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Executed: Schema.TaggedStruct<"Executed", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly leader: Schema.String;
    readonly rows: Schema.$Array<Schema.Unknown>;
    readonly open: Schema.Boolean;
    readonly results: Schema.optional<Schema.$Array<Schema.$Array<Schema.Unknown>>>;
}>;
/**
 * The leader refused the statement. `error` is the failure's tag; `code` and
 * `message` are SQLite's, when SQLite refused it.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Failed: Schema.TaggedStruct<"Failed", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly error: Schema.String;
    readonly leader: Schema.optional<Schema.String>;
    readonly open: Schema.optional<Schema.Boolean>;
    readonly code: Schema.optional<Schema.Number>;
    readonly message: Schema.optional<Schema.String>;
}>;
/**
 * A worker serves statements from now on.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Ready: Schema.TaggedStruct<"Ready", {}>;
/**
 * Every message on the channel.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const Message: Schema.Union<readonly [Schema.TaggedStruct<"Execute", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly sql: Schema.String;
    readonly params: Schema.$Array<Schema.Unknown>;
    readonly transaction: Schema.NullOr<Schema.String>;
    readonly opened: Schema.optional<Schema.Number>;
    readonly batch: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly sql: Schema.String;
        readonly params: Schema.$Array<Schema.Unknown>;
    }>>>;
}>, Schema.TaggedStruct<"Executed", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly leader: Schema.String;
    readonly rows: Schema.$Array<Schema.Unknown>;
    readonly open: Schema.Boolean;
    readonly results: Schema.optional<Schema.$Array<Schema.$Array<Schema.Unknown>>>;
}>, Schema.TaggedStruct<"Failed", {
    readonly client: Schema.String;
    readonly id: Schema.Number;
    readonly error: Schema.String;
    readonly leader: Schema.optional<Schema.String>;
    readonly open: Schema.optional<Schema.Boolean>;
    readonly code: Schema.optional<Schema.Number>;
    readonly message: Schema.optional<Schema.String>;
}>, Schema.TaggedStruct<"Ready", {}>]>;
/**
 * The value form of {@link Message}.
 *
 * @category protocol
 * @since 1.0.0
 */
export type Message = typeof Message.Type;
/**
 * Decodes a channel message, or `undefined` for anything else posted there.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const decode: (input: unknown) => Message | undefined;
/**
 * Encodes a message for `postMessage`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const encode: (message: Message) => unknown;
/**
 * The app database's channel for the engine `name`.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const channel: (name: string) => string;
/**
 * The Web Lock a tab holds while it lives, so the leader rolls back a
 * transaction the tab leaves open when it ends.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const clientLock: (name: string, client: string) => string;
/**
 * The leader's table in the app's database: each tab's receipt, the request
 * whose change it last committed or whose transaction it holds open, written
 * inside the transaction that commits the change. It commits with the change
 * and goes with a rollback, so a new leader can tell whether a request the old
 * one never answered committed.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const commits = "shared_sqlite_commits";
/**
 * The leader's table of each tab's last committed reply: the rows the request
 * named in its receipt returned, written in the transaction that commits it
 * when it returned any. A new leader answers a request the old one committed
 * with them.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const replies = "shared_sqlite_replies";
/**
 * Encodes rows as {@link replies} keeps them.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const encodeRows: (rows: ReadonlyArray<unknown>) => string;
/**
 * Decodes rows {@link encodeRows} encoded.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const decodeRows: (text: string) => Array<unknown>;
/**
 * Encodes a batch's rows, one array per statement, as {@link replies} keeps
 * them.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const encodeResults: (results: ReadonlyArray<ReadonlyArray<unknown>>) => string;
/**
 * Decodes a batch's rows {@link encodeResults} encoded.
 *
 * @category protocol
 * @since 1.0.0
 */
export declare const decodeResults: (text: string) => Array<Array<unknown>>;

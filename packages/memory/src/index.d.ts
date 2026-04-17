import * as zod from 'zod';
import { z } from 'zod';
import * as zod_v4_core from 'zod/v4/core';
import { Effect, Context, Layer, Metric } from 'effect';
import { SmithersError } from '@smithers/errors/SmithersError';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import { BunSQLiteDatabase as BunSQLiteDatabase$1 } from 'drizzle-orm/bun-sqlite';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';

type MemoryNamespaceKind$1 = "workflow" | "agent" | "user" | "global";

type MemoryNamespace$3 = {
    kind: MemoryNamespaceKind$1;
    id: string;
};

type WorkingMemoryConfig$1<T extends z.ZodObject<any> = z.ZodObject<any>> = {
    schema?: T;
    namespace: MemoryNamespace$3;
    ttlMs?: number;
};

type TaskMemoryConfig$1 = {
    namespace?: string | MemoryNamespace$3;
    recall?: {
        namespace?: MemoryNamespace$3;
        query?: string;
        topK?: number;
    };
    remember?: {
        namespace?: MemoryNamespace$3;
        key?: string;
    };
    threadId?: string;
};

type SemanticRecallConfig$1 = {
    topK?: number;
    namespace?: MemoryNamespace$3;
    similarityThreshold?: number;
};

type MessageHistoryConfig$1 = {
    lastMessages?: number;
    threadId?: string;
};

type MemoryThread$1 = {
    threadId: string;
    namespace: string;
    title?: string | null;
    metadataJson?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
};

type MemoryFact$1 = {
    namespace: string;
    key: string;
    valueJson: string;
    schemaSig?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
    ttlMs?: number | null;
};

type MemoryMessage$1 = {
    id: string;
    threadId: string;
    role: string;
    contentJson: string;
    runId?: string | null;
    nodeId?: string | null;
    createdAtMs: number;
};

type MemoryStore$2 = {
    getFact: (ns: MemoryNamespace$3, key: string) => Promise<MemoryFact$1 | undefined>;
    setFact: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number) => Promise<void>;
    deleteFact: (ns: MemoryNamespace$3, key: string) => Promise<void>;
    listFacts: (ns: MemoryNamespace$3) => Promise<MemoryFact$1[]>;
    createThread: (ns: MemoryNamespace$3, title?: string) => Promise<MemoryThread$1>;
    getThread: (threadId: string) => Promise<MemoryThread$1 | undefined>;
    deleteThread: (threadId: string) => Promise<void>;
    saveMessage: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Promise<void>;
    listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage$1[]>;
    countMessages: (threadId: string) => Promise<number>;
    deleteExpiredFacts: () => Promise<number>;
    getFactEffect: (ns: MemoryNamespace$3, key: string) => Effect.Effect<MemoryFact$1 | undefined, SmithersError>;
    setFactEffect: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number) => Effect.Effect<void, SmithersError>;
    deleteFactEffect: (ns: MemoryNamespace$3, key: string) => Effect.Effect<void, SmithersError>;
    listFactsEffect: (ns: MemoryNamespace$3) => Effect.Effect<MemoryFact$1[], SmithersError>;
    createThreadEffect: (ns: MemoryNamespace$3, title?: string) => Effect.Effect<MemoryThread$1, SmithersError>;
    getThreadEffect: (threadId: string) => Effect.Effect<MemoryThread$1 | undefined, SmithersError>;
    deleteThreadEffect: (threadId: string) => Effect.Effect<void, SmithersError>;
    saveMessageEffect: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    listMessagesEffect: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$1[], SmithersError>;
    countMessagesEffect: (threadId: string) => Effect.Effect<number, SmithersError>;
    deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
};

type MemoryServiceApi$1 = {
    readonly getFact: (ns: MemoryNamespace$3, key: string) => Effect.Effect<MemoryFact$1 | undefined, SmithersError>;
    readonly setFact: (ns: MemoryNamespace$3, key: string, value: unknown, ttlMs?: number) => Effect.Effect<void, SmithersError>;
    readonly deleteFact: (ns: MemoryNamespace$3, key: string) => Effect.Effect<void, SmithersError>;
    readonly listFacts: (ns: MemoryNamespace$3) => Effect.Effect<MemoryFact$1[], SmithersError>;
    readonly createThread: (ns: MemoryNamespace$3, title?: string) => Effect.Effect<MemoryThread$1, SmithersError>;
    readonly getThread: (threadId: string) => Effect.Effect<MemoryThread$1 | undefined, SmithersError>;
    readonly deleteThread: (threadId: string) => Effect.Effect<void, SmithersError>;
    readonly saveMessage: (msg: Omit<MemoryMessage$1, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    readonly listMessages: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage$1[], SmithersError>;
    readonly countMessages: (threadId: string) => Effect.Effect<number, SmithersError>;
    readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;
    readonly store: MemoryStore$2;
};

type MemoryProcessorConfig$1 = {
    processors?: string[];
};

type MemoryProcessor$4 = {
    name: string;
    process: (store: MemoryStore$2) => Promise<void>;
    processEffect: (store: MemoryStore$2) => Effect.Effect<void, SmithersError>;
};

type MemoryLayerConfig$2 = {
    db: BunSQLiteDatabase$1<any>;
};

/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
declare function namespaceToString(ns: MemoryNamespace$2): string;
type MemoryNamespace$2 = MemoryNamespace$3;

/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {string} str
 * @returns {MemoryNamespace}
 */
declare function parseNamespace(str: string): MemoryNamespace$1;
type MemoryNamespace$1 = MemoryNamespace$3;

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
declare function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore$1;
type BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type MemoryStore$1 = MemoryStore$2;

/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/**
 * @returns {MemoryProcessor}
 */
declare function TtlGarbageCollector(): MemoryProcessor$3;
type MemoryProcessor$3 = MemoryProcessor$4;

/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/**
 * @param {number} maxTokens
 * @returns {MemoryProcessor}
 */
declare function TokenLimiter(maxTokens: number): MemoryProcessor$2;
type MemoryProcessor$2 = MemoryProcessor$4;

/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */
/**
 * @param {{ run: (prompt: string) => Promise<any> }} agent
 * @returns {MemoryProcessor}
 */
declare function Summarizer(agent: {
    run: (prompt: string) => Promise<any>;
}): MemoryProcessor$1;
type MemoryProcessor$1 = MemoryProcessor$4;

declare class MemoryService extends Context.TagClassShape<"MemoryService", MemoryServiceApi$1> {
}

/** @typedef {import("./MemoryLayerConfig.ts").MemoryLayerConfig} MemoryLayerConfig */
/**
 * @param {MemoryLayerConfig} config
 * @returns {Layer.Layer<MemoryService, never, never>}
 */
declare function createMemoryLayer(config: MemoryLayerConfig$1): Layer.Layer<MemoryService, never, never>;
type MemoryLayerConfig$1 = MemoryLayerConfig$2;

declare const memoryFactReads: Metric.Metric.Counter<number>;

declare const memoryFactWrites: Metric.Metric.Counter<number>;

declare const memoryRecallQueries: Metric.Metric.Counter<number>;

declare const memoryMessageSaves: Metric.Metric.Counter<number>;

declare const memoryRecallDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const smithersMemoryFacts: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_memory_facts";
    schema: undefined;
    columns: {
        namespace: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "namespace";
            tableName: "_smithers_memory_facts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        key: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "key";
            tableName: "_smithers_memory_facts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        valueJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "value_json";
            tableName: "_smithers_memory_facts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        schemaSig: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "schema_sig";
            tableName: "_smithers_memory_facts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_memory_facts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "updated_at_ms";
            tableName: "_smithers_memory_facts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ttlMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "ttl_ms";
            tableName: "_smithers_memory_facts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersMemoryThreads: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_memory_threads";
    schema: undefined;
    columns: {
        threadId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "thread_id";
            tableName: "_smithers_memory_threads";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        namespace: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "namespace";
            tableName: "_smithers_memory_threads";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        title: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "title";
            tableName: "_smithers_memory_threads";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        metadataJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "metadata_json";
            tableName: "_smithers_memory_threads";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_memory_threads";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "updated_at_ms";
            tableName: "_smithers_memory_threads";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersMemoryMessages: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_memory_messages";
    schema: undefined;
    columns: {
        id: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "id";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        threadId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "thread_id";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        role: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "role";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        contentJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "content_json";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_memory_messages";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_memory_messages";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;

type MemoryFact = MemoryFact$1;
type MemoryLayerConfig = MemoryLayerConfig$2;
type MemoryMessage = MemoryMessage$1;
type MemoryNamespace = MemoryNamespace$3;
type MemoryNamespaceKind = MemoryNamespaceKind$1;
type MemoryProcessor = MemoryProcessor$4;
type MemoryProcessorConfig = MemoryProcessorConfig$1;
type MemoryServiceApi = MemoryServiceApi$1;
type MemoryStore = MemoryStore$2;
type MemoryThread = MemoryThread$1;
type MessageHistoryConfig = MessageHistoryConfig$1;
type SemanticRecallConfig = SemanticRecallConfig$1;
type TaskMemoryConfig = TaskMemoryConfig$1;
type WorkingMemoryConfig<T extends zod.z.ZodObject<any> = zod.ZodObject<any, zod_v4_core.$strip>> = WorkingMemoryConfig$1<T>;

export { type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryProcessor, type MemoryProcessorConfig, MemoryService, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type SemanticRecallConfig, Summarizer, type TaskMemoryConfig, TokenLimiter, TtlGarbageCollector, type WorkingMemoryConfig, createMemoryLayer, createMemoryStore, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, namespaceToString, parseNamespace, smithersMemoryFacts, smithersMemoryMessages, smithersMemoryThreads };

import type { AgentLike } from "@smithers/agents/AgentLike";
import type { z } from "zod";
import type { SerializedCtx } from "./SerializedCtx.ts";
import type { HostNodeJson } from "./HostNodeJson.ts";

export type ExternalSmithersConfig<S extends Record<string, z.ZodObject<z.ZodRawShape>>> = {
	schemas: S;
	agents: Record<string, AgentLike>;
	/** Synchronous build function that returns a HostNode JSON tree. */
	buildFn: (ctx: SerializedCtx) => HostNodeJson;
	dbPath?: string;
};

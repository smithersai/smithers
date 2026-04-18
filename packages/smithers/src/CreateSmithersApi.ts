import type React from "react";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
	Sequence as BaseSequence,
	Parallel as BaseParallel,
	MergeQueue as BaseMergeQueue,
	Branch as BaseBranch,
	Loop as BaseLoop,
	Ralph as BaseRalph,
		ContinueAsNew as BaseContinueAsNew,
		continueAsNew as baseContinueAsNew,
		Worktree as BaseWorktree,
		Timer as BaseTimer,
} from "@smithers-orchestrator/components";
import type { ApprovalProps } from "@smithers-orchestrator/components/components/ApprovalProps";
import type { DepsSpec } from "@smithers-orchestrator/components/components/DepsSpec";
import type { SandboxProps } from "@smithers-orchestrator/components/components/SandboxProps";
import type { SignalProps } from "@smithers-orchestrator/components/components/SignalProps";
import type { TaskProps } from "@smithers-orchestrator/components/components/TaskProps";
import type { WorkflowProps } from "@smithers-orchestrator/components/components/WorkflowProps";
import type { SmithersWorkflow } from "@smithers-orchestrator/components/SmithersWorkflow";
import type { SmithersWorkflowOptions } from "@smithers-orchestrator/scheduler/SmithersWorkflowOptions";
import type { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import type { z } from "zod";

/** Union of all Zod schema values registered in the schema, constrained to ZodObject. */
type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<z.ZodRawShape>>;
type RuntimeSchema<Schema> = Schema extends { input: infer Input }
	? Omit<Schema, "input"> & {
			input: Input extends z.ZodTypeAny ? z.infer<Input> : Input;
		}
	: Schema;

export type CreateSmithersApi<Schema = unknown> = {
	Workflow: (props: WorkflowProps) => React.ReactElement;
	Approval: <Row>(props: ApprovalProps<Row, SchemaOutput<Schema>>) => React.ReactElement;
	Task: <Row, D extends DepsSpec = {}>(
		props: TaskProps<Row, SchemaOutput<Schema>, D>,
	) => React.ReactElement;
	Sequence: typeof BaseSequence;
	Parallel: typeof BaseParallel;
	MergeQueue: typeof BaseMergeQueue;
	Branch: typeof BaseBranch;
	Loop: typeof BaseLoop;
	Ralph: typeof BaseRalph;
	ContinueAsNew: typeof BaseContinueAsNew;
	continueAsNew: typeof baseContinueAsNew;
	Worktree: typeof BaseWorktree;
	Sandbox: (props: SandboxProps) => React.ReactElement;
	Signal: <SignalSchema extends z.ZodObject<z.ZodRawShape>>(
		props: SignalProps<SignalSchema>,
	) => React.ReactElement;
	Timer: typeof BaseTimer;
	useCtx: () => SmithersCtx<RuntimeSchema<Schema>>;
	smithers: (
		build: (ctx: SmithersCtx<RuntimeSchema<Schema>>) => React.ReactElement,
		opts?: SmithersWorkflowOptions,
	) => SmithersWorkflow<RuntimeSchema<Schema>>;
	db: BunSQLiteDatabase<Record<string, unknown>>;
	tables: { [K in keyof Schema]: unknown };
	outputs: { [K in keyof Schema]: Schema[K] };
};

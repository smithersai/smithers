import type React from "react";
import type { Workflow } from "@smithers/core";
import type { WorkflowDriverOptions } from "@smithers/driver/WorkflowDriverOptions";

export type SmithersWorkflow<Schema = unknown> = Workflow<
  Schema,
  React.ReactElement
>;

export type SmithersWorkflowDriverOptions<Schema = unknown> =
  WorkflowDriverOptions<Schema, React.ReactElement>;

export type {
  EngineDecision,
  RenderContext,
  WaitReason,
  SmithersWorkflowOptions,
} from "@smithers/scheduler";
export type { RunOptions, RunResult, SmithersCtx } from "@smithers/driver";
export type { WorkflowRuntime, WorkflowSession } from "@smithers/core/workflow-types";
export type {
  ExtractOptions,
  HostElement,
  HostNode,
  HostText,
  TaskDescriptor,
  WorkflowGraph,
  XmlElement,
  XmlNode,
  XmlText,
} from "@smithers/graph";

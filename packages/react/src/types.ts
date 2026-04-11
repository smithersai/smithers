import type React from "react";
import type {
  Workflow,
  WorkflowDriverOptions,
} from "@smithers/core";

export type SmithersWorkflow<Schema = unknown> = Workflow<
  Schema,
  React.ReactElement
>;

export type SmithersWorkflowDriverOptions<Schema = unknown> =
  WorkflowDriverOptions<Schema, React.ReactElement>;

export type {
  EngineDecision,
  RenderContext,
  RunOptions,
  RunResult,
  SmithersCtx,
  SmithersWorkflowOptions,
  WaitReason,
  WorkflowRuntime,
  WorkflowSession,
} from "@smithers/core";
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

import * as _smithers_graph_types from '@smithers/graph/types';
import { ExtractGraph as ExtractGraph$1, HostNode as HostNode$1 } from '@smithers/graph/types';
import * as React$1 from 'react';
import React__default from 'react';
import { WorkflowDriver } from '@smithers/driver';
import { SmithersCtx } from '@smithers/driver/SmithersCtx';
export { SmithersCtx } from '@smithers/driver/SmithersCtx';

type SmithersRendererOptions$1 = {
    extractGraph?: ExtractGraph$1;
};

type HostContainer$1 = {
    root: HostNode$1 | null;
};

declare class SmithersRenderer {
    /**
   * @param {SmithersRendererOptions} [options]
   */
    constructor(options?: SmithersRendererOptions);
    /** @type {HostContainer} */
    container: HostContainer;
    /** @type {any} */
    root: any;
    /** @type {ExtractGraph | undefined} */
    extractGraph: ExtractGraph | undefined;
    /**
   * @param {React.ReactElement} element
   * @param {ExtractOptions} [opts]
   * @returns {Promise<WorkflowGraph>}
   */
    render(element: React.ReactElement, opts?: ExtractOptions): Promise<WorkflowGraph>;
    /**
   * @returns {HostNode | null}
   */
    getRoot(): HostNode | null;
}
type ExtractGraph = _smithers_graph_types.ExtractGraph;
type ExtractOptions = _smithers_graph_types.ExtractOptions;
type HostContainer = HostContainer$1;
type MutableHostElement = _smithers_graph_types.HostElement & {
    props: Record<string, string>;
    rawProps: Record<string, unknown>;
    children: HostNode[];
};
type HostNode = _smithers_graph_types.HostNode;
type MutableHostText = _smithers_graph_types.HostText & {
    text: string;
};
type React = React$1.default;
type SmithersRendererOptions = SmithersRendererOptions$1;
type WorkflowGraph = _smithers_graph_types.WorkflowGraph;

/**
 * @template [Schema=unknown]
 * @extends {WorkflowDriver<Schema>}
 */
declare class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<Schema> {
}

/**
 * @template Schema
 * @returns {{ SmithersContext: React.Context<SmithersCtx<Schema> | null>, useCtx: () => SmithersCtx<Schema> }}
 */
declare function createSmithersContext<Schema>(): {
    SmithersContext: React__default.Context<SmithersCtx<Schema> | null>;
    useCtx: () => SmithersCtx<Schema>;
};

/** @type {React.Context<SmithersCtx<any> | null>} */
declare const SmithersContext: React__default.Context<SmithersCtx<any> | null>;

export { type ExtractGraph, type ExtractOptions, type HostContainer, type HostNode, type MutableHostElement, type MutableHostText, type React, ReactWorkflowDriver, SmithersContext, SmithersRenderer, type SmithersRendererOptions, type WorkflowGraph, createSmithersContext };

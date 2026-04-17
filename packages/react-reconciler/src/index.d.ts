import * as _smithers_graph_types from '@smithers/graph/types';
import { HostNode as HostNode$1, ExtractGraph } from '@smithers/graph/types';
import * as React__default__default__default from 'react';
import React__default__default__default__default from 'react';
import * as _smithers_driver from '@smithers/driver';
import { WorkflowDriver } from '@smithers/driver';
import { SmithersCtx } from '@smithers/driver/SmithersCtx';
export { SmithersCtx } from '@smithers/driver/SmithersCtx';

type SmithersRendererOptions$1 = {
    extractGraph?: ExtractGraph;
};

type HostContainer$1 = {
    root: HostNode$1 | null;
};

declare class SmithersRenderer {
    /**
   * @param {SmithersRendererOptions} [options]
   */
    constructor(options?: SmithersRendererOptions);
    container: {
        root: null;
    };
    root: any;
    extractGraph: _smithers_graph_types.ExtractGraph | undefined;
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
type ExtractOptions = _smithers_graph_types.ExtractOptions;
type HostContainer = HostContainer$1;
type HostNode = _smithers_graph_types.HostNode;
type React = React__default__default__default.default;
type SmithersRendererOptions = SmithersRendererOptions$1;
type WorkflowGraph = _smithers_graph_types.WorkflowGraph;

/**
 * @template [Schema=unknown]
 * @extends {WorkflowDriver<Schema>}
 */
declare class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<Schema> {
    /**
   * @param {import("@smithers/driver").WorkflowDriverOptions<Schema>} options
   */
    constructor(options: _smithers_driver.WorkflowDriverOptions<Schema>);
}

/**
 * @template Schema
 * @returns {{ SmithersContext: React.Context<SmithersCtx<Schema> | null>, useCtx: () => SmithersCtx<Schema> }}
 */
declare function createSmithersContext<Schema>(): {
    SmithersContext: React__default__default__default__default.Context<SmithersCtx<Schema> | null>;
    useCtx: () => SmithersCtx<Schema>;
};

/** @type {React.Context<SmithersCtx<any> | null>} */
declare const SmithersContext: React__default__default__default__default.Context<SmithersCtx<any> | null>;

export { type ExtractOptions, type HostContainer, type HostNode, type React, ReactWorkflowDriver, SmithersContext, SmithersRenderer, type SmithersRendererOptions, type WorkflowGraph, createSmithersContext };

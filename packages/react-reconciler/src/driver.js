import { WorkflowDriver, } from "@smithers/driver";
import { SmithersRenderer } from "./reconciler.js";

/**
 * @template [Schema=unknown]
 * @extends {WorkflowDriver<Schema>}
 */
export class ReactWorkflowDriver extends WorkflowDriver {
    /**
   * @param {import("@smithers/driver").WorkflowDriverOptions<Schema>} options
   */
    constructor(options) {
        const renderer = options.renderer ?? new SmithersRenderer();
        super({
            ...options,
            renderer,
        });
    }
}

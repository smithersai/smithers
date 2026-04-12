import {
  WorkflowDriver,
  type WorkflowDriverOptions,
} from "@smithers/driver";
import { SmithersRenderer } from "./reconciler.ts";

export class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<Schema> {
  constructor(options: WorkflowDriverOptions<Schema>) {
    const renderer = options.renderer ?? new SmithersRenderer();
    super({
      ...options,
      renderer,
    });
  }
}

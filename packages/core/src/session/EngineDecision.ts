import type { TaskDescriptor } from "../graph.ts";
import type { SmithersError } from "../errors.ts";
import type { ContinueAsNewTransition } from "../durables/index.ts";
import type { RenderContext } from "./RenderContext.ts";
import type { RunResult } from "./RunResult.ts";
import type { WaitReason } from "./WaitReason.ts";

export type EngineDecision =
  | { readonly _tag: "Execute"; readonly tasks: readonly TaskDescriptor[] }
  | { readonly _tag: "ReRender"; readonly context: RenderContext }
  | {
      readonly _tag: "Wait";
      readonly reason: WaitReason;
    }
  | {
      readonly _tag: "ContinueAsNew";
      readonly transition: ContinueAsNewTransition;
    }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: SmithersError };

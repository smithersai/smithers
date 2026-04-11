import type { TaskDescriptor } from "@smithers/graph/types";
import type { RunResult } from "../RunResult";
import type { RenderContext } from "./RenderContext";
import type { WaitReason } from "./WaitReason";

export type EngineDecision =
  | { readonly _tag: "Execute"; readonly tasks: readonly TaskDescriptor[] }
  | { readonly _tag: "ReRender"; readonly context: RenderContext }
  | { readonly _tag: "Wait"; readonly reason: WaitReason }
  | { readonly _tag: "ContinueAsNew"; readonly transition: unknown }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: unknown };

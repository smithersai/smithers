import { SmithersError } from "./SmithersError.ts";
import type { ErrorWrapOptions } from "./ErrorWrapOptions.ts";
export declare function toSmithersError(cause: unknown, label?: string, options?: ErrorWrapOptions): SmithersError;

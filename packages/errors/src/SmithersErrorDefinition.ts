import type { SmithersErrorCategory } from "./SmithersErrorCategory.ts";

export type SmithersErrorDefinition = {
  readonly category: SmithersErrorCategory;
  readonly when: string;
  readonly details?: string;
};

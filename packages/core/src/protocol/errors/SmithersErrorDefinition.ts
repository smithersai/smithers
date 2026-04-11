import type { SmithersErrorCategory } from "./SmithersErrorCategory";

export type SmithersErrorDefinition = {
  readonly category: SmithersErrorCategory;
  readonly when: string;
  readonly details?: string;
};

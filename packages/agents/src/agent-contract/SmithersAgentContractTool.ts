import type { SmithersAgentToolCategory } from "./SmithersAgentToolCategory";

export type SmithersAgentContractTool = {
  name: string;
  description: string;
  destructive: boolean;
  category: SmithersAgentToolCategory;
};

import type { XmlNode } from "./types";
import type { TaskDescriptor } from "./types";

export type ExtractResult = {
  xml: XmlNode | null;
  tasks: TaskDescriptor[];
  mountedTaskIds: string[];
};

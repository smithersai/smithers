import type { XmlNode } from "./XmlNode";
import type { TaskDescriptor } from "./TaskDescriptor";

export type GraphSnapshot = {
  runId: string;
  frameNo: number;
  xml: XmlNode | null;
  tasks: TaskDescriptor[];
};

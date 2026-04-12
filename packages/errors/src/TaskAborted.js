import { Data } from "effect";
export class TaskAborted extends Data.TaggedError("TaskAborted") {
}

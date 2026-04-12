import { type WorkerTask } from "./entity-worker";
type WorkerExecutionResult = {
    terminal: boolean;
};
type TaskWorkerDispatchSubscriber = (task: WorkerTask) => void;
export declare function dispatchWorkerTask(task: WorkerTask, execute: () => Promise<WorkerExecutionResult>): Promise<WorkerExecutionResult>;
export declare function subscribeTaskWorkerDispatches(subscriber: TaskWorkerDispatchSubscriber): () => void;
export {};

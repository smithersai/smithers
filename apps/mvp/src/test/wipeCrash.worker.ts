import { parentPort, workerData } from "node:worker_threads"
import { pageWipe, type WipeHost } from "../wipe.ts"

// A terminated worker cannot call close. Node's shared Web Locks release its sign-out claim just as a crashed tab's do.
const unexpected = (): never => { throw new Error("A pending sign-out must not open device stores") }
const host: WipeHost = {
  locks: { request: ((_name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) =>
    navigator.locks.request(workerData.lock, options, callback)) as LockManager["request"] },
  channel: () => new BroadcastChannel(workerData.lock),
  marks: { getItem: unexpected, setItem: unexpected, removeItem: unexpected },
  directory: async () => unexpected(),
  indexedDB: { deleteDatabase: unexpected },
  reload: unexpected,
}
const page = pageWipe(host, { engine: "unused", outbox: "unused" })
void page.signOut(() => { parentPort!.postMessage("pending"); return new Promise<Response>(() => {}) })

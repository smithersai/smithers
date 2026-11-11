import { fileURLToPath } from "node:url"

/** Absolute roots of the flow trees that file-router scans read. */
export const routerRoot = fileURLToPath(new URL("./fixtures/router/flows", import.meta.url))
export const hiddenRuntimeRoot = fileURLToPath(new URL("./fixtures/hidden-runtime/flows", import.meta.url))
export const hiddenRecordRoot = fileURLToPath(new URL("./fixtures/hidden-records/flows", import.meta.url))

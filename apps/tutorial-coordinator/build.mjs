import { bundle } from "../../flows/coding/build.mjs"
await bundle(new URL("./src/server.ts",import.meta.url).pathname,new URL("../../dist/tutorial-coordinator/server.mjs",import.meta.url).pathname)

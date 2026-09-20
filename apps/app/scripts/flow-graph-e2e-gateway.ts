/** Compatibility entry; the engine and dynamically authored modules share ESM. */
void import("./flow-graph-e2e-gateway.mts").catch(error => {
  console.error(error)
  process.exitCode = 1
})

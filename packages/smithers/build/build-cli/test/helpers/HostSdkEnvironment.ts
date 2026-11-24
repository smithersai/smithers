/**
 * Removes the SDK the developer's shell selected from each test worker.
 *
 * The planner keys a command on the content of the `SDKROOT` and
 * `DEVELOPER_DIR` it inherits from `process.env`, and declines caching under
 * one too large to read whole, as an installed Apple SDK is. A shell that
 * exports either would decide every caching assertion in the suite. A test
 * that needs an SDK names one itself.
 */
delete process.env["SDKROOT"]
delete process.env["DEVELOPER_DIR"]

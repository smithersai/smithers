// @smithers-type-exports-begin
/** @typedef {import("./alert-runtime.ts").AlertHumanRequestOptions} AlertHumanRequestOptions */
// @smithers-type-exports-end


/** @typedef {import("./scheduler.ts").scheduler} scheduler */

/** @typedef {import("./alert-runtime.ts").AlertRuntimeServices} AlertRuntimeServices */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
export class AlertRuntime {
    policy;
    services;
    /**
   * @param {SmithersAlertPolicy} policy
   * @param {AlertRuntimeServices} services
   */
    constructor(policy, services) {
        this.policy = policy;
        this.services = services;
    }
    start() { }
    stop() { }
}

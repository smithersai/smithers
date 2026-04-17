// @smithers-type-exports-begin
/** @typedef {import("./AlertHumanRequestOptions.ts").AlertHumanRequestOptions} AlertHumanRequestOptions */
/** @typedef {import("./AlertRuntimeServices.ts").AlertRuntimeServices} AlertRuntimeServices */
// @smithers-type-exports-end

/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
export class AlertRuntime {
    /** @type {SmithersAlertPolicy} */
    policy;
    /** @type {AlertRuntimeServices} */
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

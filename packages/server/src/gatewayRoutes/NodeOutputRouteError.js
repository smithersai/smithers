/** @typedef {import("@smithers-orchestrator/protocol/errors").NodeOutputErrorCode} NodeOutputErrorCode */

export class NodeOutputRouteError extends Error {
    /**
     * @param {NodeOutputErrorCode} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = "NodeOutputRouteError";
        /** @type {NodeOutputErrorCode} */
        this.code = code;
    }
}

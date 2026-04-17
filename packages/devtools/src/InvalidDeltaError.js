export class InvalidDeltaError extends Error {
    /** @type {"InvalidDelta"} */
    code = "InvalidDelta";
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "InvalidDeltaError";
    }
}

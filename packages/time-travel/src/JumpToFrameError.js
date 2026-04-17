export class JumpToFrameError extends Error {
  /** @type {string} */
  code;

  /** @type {string | undefined} */
  hint;

  /** @type {Record<string, unknown> | undefined} */
  details;

  /**
   * @param {string} code
   * @param {string} message
   * @param {{ hint?: string; details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "JumpToFrameError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

import { type Model, ModelError } from "@smthrs/model"

/**
 * A quota or credit refusal as final: its retry hints dropped, so no step waits out a key that was refused or
 * ran out (`isTerminalRefusal` in `@smthrs/model`). HTTP 402 becomes `out_of_credit`
 * before crossing the proxy wire, which retains error codes but not provider HTTP statuses.
 * A plain rate limit keeps its hints: it passes.
 */
export const final = (error: ModelError.ModelError): ModelError.ModelError =>
  error.httpStatus === 402 || error.code === "quota_exceeded" || error.code === "out_of_credit"
    ? new ModelError.ModelError({
      code: error.httpStatus === 402 && error.code !== "quota_exceeded" ? "out_of_credit" : error.code,
      message: error.message,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    })
    : error

/** A failed model call, its key's refusal made final ({@link final}); any other failure unchanged. */
export const finalFailure = (error: Model.ModelFailure): Model.ModelFailure =>
  error instanceof ModelError.ModelError ? final(error) : error


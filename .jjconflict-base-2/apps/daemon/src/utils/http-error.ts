import { ZodError } from "zod"

export class HttpError extends Error {
  status: number
  details?: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.details = details
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return Response.json(
      {
        error: error.message,
        details: error.details ?? null,
      },
      { status: error.status }
    )
  }

  if (error instanceof ZodError) {
    return Response.json(
      {
        error: "Invalid request",
        details: error.flatten(),
      },
      { status: 400 }
    )
  }

  const message = error instanceof Error ? error.message : "Unexpected server error"

  return Response.json(
    {
      error: message,
    },
    { status: 500 }
  )
}

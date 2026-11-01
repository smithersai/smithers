/** Surface Electric's invalid-shape diagnostic instead of hiding its body behind a status/empty-row assertion. */
export const explainShapeFailure = async (response: Response): Promise<void> => {
  if (response.status !== 400) return
  // Only protocol headers. Never copy cookies, credentials or the request (whose parameters can carry content).
  const headers = Object.fromEntries(
    ["content-type", "electric-server", "x-request-id"].map((name) => [name, response.headers.get(name)]),
  )
  throw new Error(`Electric shape returned 400: ${JSON.stringify(headers)}\n${await response.clone().text()}`)
}

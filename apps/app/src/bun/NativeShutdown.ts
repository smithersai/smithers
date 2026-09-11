/** Electrobun's quit event is synchronous; veto it until our asynchronous cleanup completes. */
export const createNativeShutdown = (options: {
  readonly stop: () => Promise<void>
  readonly quit: (code: number) => void
  readonly onBeforeQuit: (handler: (event: { response?: { allow: boolean } }) => void) => void
  readonly log: (message: string) => void
}): (() => Promise<void>) => {
  let finished = false
  let pending: Promise<void> | undefined
  const shutdown = (): Promise<void> => pending ??= (async () => {
    let code = 0
    try {
      await options.stop()
    } catch (error) {
      code = 1
      options.log(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    finished = true
    options.quit(code)
  })()
  options.onBeforeQuit((event) => {
    if (finished) return
    event.response = { allow: false }
    void shutdown()
  })
  return shutdown
}

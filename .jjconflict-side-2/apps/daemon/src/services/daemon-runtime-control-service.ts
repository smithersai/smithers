let restartDaemonHandler: (() => Promise<void>) | null = null

export function registerDaemonRestartHandler(handler: () => Promise<void>) {
  restartDaemonHandler = handler
}

export function scheduleDaemonRestart() {
  if (!restartDaemonHandler) {
    return false
  }

  const restartTimer = setTimeout(() => {
    void restartDaemonHandler?.()
  }, 25)
  restartTimer.unref()
  return true
}

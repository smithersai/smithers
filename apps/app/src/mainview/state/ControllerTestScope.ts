import { afterEach } from "bun:test"
import { createAppController } from "./AppController"
import type { AppController } from "./AppController"

/**
 * Call once at a test file's top level to register that file's cleanup hook.
 * A failed assertion must not leave its controller's polls, subscriptions or
 * identity listeners running in later tests. Explicit early disposal remains
 * safe because the controller's dispose contract is idempotent.
 */
export const scopedControllers = (): typeof createAppController => {
  const controllers = new Set<AppController>()
  afterEach(async () => {
    const errors: unknown[] = []
    try {
      for (const controller of controllers) {
        try {
          await controller.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      controllers.clear()
    }
    if (errors.length > 0) throw new AggregateError(errors, "Controller fixture cleanup failed")
  })
  return (...args) => {
    const controller = createAppController(...args)
    controllers.add(controller)
    return controller
  }
}

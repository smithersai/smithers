import { Scheduler } from "effect"

/**
 * The runtime's scheduler with a count of every task it dispatches. Provide it
 * to one fiber to bound that fiber's yields, or to act at its Nth yield,
 * without wall time or global spies.
 */
export const countingScheduler = (onTask: (tasks: number) => void = () => undefined) => {
  const inner = new Scheduler.MixedScheduler()
  const counts = { tasks: 0 }
  const scheduler: Scheduler.Scheduler = {
    executionMode: inner.executionMode,
    shouldYield: (fiber) => inner.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = inner.makeDispatcher()
      return {
        scheduleTask: (task, priority) => {
          counts.tasks += 1
          onTask(counts.tasks)
          dispatcher.scheduleTask(task, priority)
        },
        flush: () => dispatcher.flush()
      }
    }
  }
  return { counts, scheduler }
}

import { UiEventEnvelope } from "../shared/types";

export class MockBroker {
  private seq = 0;
  private listeners: ((event: UiEventEnvelope) => void)[] = [];
  private intervalIds: ReturnType<typeof setInterval>[] = [];

  subscribe(listener: (event: UiEventEnvelope) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private dispatch(event: Omit<UiEventEnvelope, "seq">) {
    const fullEvent: UiEventEnvelope = { ...event, seq: this.seq++ };
    this.listeners.forEach((l) => l(fullEvent));
  }

  start() {
    // Generate initial workspaces in store, but the broker just streams events.

    // A mock stream sequence!
    const msg = "I have inspected the repository. I'll launch an analysis workflow now.";
    let msgIndex = 0;

    const streamInterval = setInterval(() => {
      if (msgIndex < msg.length) {
        this.dispatch({
          workspaceId: "ws-1",
          timeMs: Date.now(),
          source: "provider",
          kind: "token_delta",
          payload: { text: msg[msgIndex] },
        });
        msgIndex++;
      } else {
        clearInterval(streamInterval);
        this.dispatch({
          workspaceId: "ws-1",
          timeMs: Date.now(),
          source: "provider",
          kind: "message_done",
          payload: null,
        });

        // Follow up with tool run
        setTimeout(() => {
          this.dispatch({
            workspaceId: "ws-1",
            timeMs: Date.now(),
            source: "smithers",
            kind: "tool_done",
            payload: {
              summary: "Tool smithers.runs.inspect a93f",
              durationMs: 42,
              status: "done",
            },
          });
          
          setTimeout(() => {
             this.dispatch({
               workspaceId: "ws-1",
               timeMs: Date.now(),
               source: "smithers",
               kind: "run_updated",
               payload: {
                 runId: "run-a93f",
                 workflowId: "auth-fix",
                 step: "validate",
                 completedSteps: 3,
                 totalSteps: 7,
               }
             });
          }, 1000);

        }, 500);
      }
    }, 50);

    this.intervalIds.push(streamInterval);
  }

  stop() {
    this.intervalIds.forEach(clearInterval);
  }
}

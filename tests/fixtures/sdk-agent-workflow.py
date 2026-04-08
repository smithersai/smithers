"""Agent task workflow using the smithers-py SDK."""
from smithers import workflow, task, run

def build(ctx):
    topic = ctx.input.get("topic", "default")
    return workflow("agent-test",
        task("analyze", output="outputA", agent="mock",
             prompt=f"Analyze: {topic}"),
    )

if __name__ == "__main__":
    run(build)

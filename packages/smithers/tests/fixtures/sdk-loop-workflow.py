"""Loop workflow that iterates until 2 outputs exist."""
from smithers import workflow, task, loop, run

def build(ctx):
    count = len(ctx.outputs("outputA"))
    done = count >= 2
    return workflow("loop-test",
        loop("counter", until=done, max_iterations=5,
             children=task("step", output="outputA",
                          payload={"value": count})),
    )

if __name__ == "__main__":
    run(build)

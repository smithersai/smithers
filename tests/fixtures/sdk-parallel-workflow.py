"""Parallel workflow with two concurrent tasks."""
from smithers import workflow, task, parallel, run

def build(ctx):
    return workflow("parallel-test",
        parallel(
            task("p1", output="outputA", payload={"value": 10}),
            task("p2", output="outputB", payload={"value": 20}),
        ),
    )

if __name__ == "__main__":
    run(build)

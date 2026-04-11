"""Static task workflow using the smithers-py SDK."""
from smithers import workflow, task, run

def build(ctx):
    return workflow("static-test",
        task("t1", output="outputA", payload={"value": 42}),
    )

if __name__ == "__main__":
    run(build)

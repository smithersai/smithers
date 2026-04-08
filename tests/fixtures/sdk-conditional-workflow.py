"""Conditional workflow: mounts task B only after task A completes."""
from smithers import workflow, task, run

def build(ctx):
    a_output = ctx.output_maybe("outputA", "a")
    children = [
        task("a", output="outputA", payload={"value": 1}),
    ]
    if a_output is not None:
        children.append(
            task("b", output="outputB", payload={"value": 2}),
        )
    return workflow("conditional-test", *children)

if __name__ == "__main__":
    run(build)

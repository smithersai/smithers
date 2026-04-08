# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
Fan-Out Fan-In — Split work into parallel chunks, then merge results.

Demonstrates: sequence, conditional rendering, parallel with dynamic children.
"""
from pydantic import BaseModel
from smithers import workflow, task, sequence, parallel, Agent, run


class SplitItem(BaseModel):
    id: str
    input: str
    context: str


class Split(BaseModel):
    items: list[SplitItem]
    total_items: int


class ProcessResult(BaseModel):
    item_id: str
    output: str
    status: str


class Merge(BaseModel):
    total_processed: int
    succeeded: int
    failed: int
    summary: str


claude = Agent("claude")


def build(ctx):
    operation = ctx.input.get("operation", "Analyze sentiment for each item independently.")
    input_text = ctx.input.get("input", "1. I love Python! 2. Orchestration is hard. 3. This SDK is great!")

    split = ctx.output_maybe(Split, "split")
    results = ctx.outputs(ProcessResult)

    children = [
        task("split",
            output=Split,
            agent=claude,
            prompt=(
                f"Divide this work into independent chunks.\n\n"
                f"Input: {input_text}\nOperation: {operation}\nMax chunks: 3"
            ),
        ),
    ]

    if split is not None:
        items = split.get("items", [])
        fan_out_tasks = [
            task(f"process-{item['id']}",
                output=ProcessResult,
                agent=claude,
                continue_on_fail=True,
                prompt=f"Process item {item['id']}: {item['input']}\nOperation: {operation}",
            )
            for item in items
        ]
        children.append(parallel(*fan_out_tasks, max_concurrency=5))

    result_summaries = "\n".join(
        f"- {r.get('itemId', '?')}: {r.get('status', '?')}" for r in results
    )
    children.append(
        task("merge", output=Merge, agent=claude,
             prompt=f"Combine results:\n{result_summaries or '(none yet)'}"),
    )

    return workflow("fan-out-fan-in", sequence(*children))


if __name__ == "__main__":
    run(build, outputs=[Split, ProcessResult, Merge])

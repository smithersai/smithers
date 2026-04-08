# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
Simple Workflow — Research a topic, then write an article about it.

Demonstrates: sequence, agent tasks, Pydantic model outputs, ctx.output_maybe.
"""
from pydantic import BaseModel
from smithers import workflow, task, sequence, Agent, run


class Research(BaseModel):
    summary: str
    key_points: list[str]


class Output(BaseModel):
    article: str
    word_count: int


researcher = Agent("researcher")
writer = Agent("writer")


def build(ctx):
    topic = ctx.input.get("topic", "Python workflow orchestration")
    research = ctx.output_maybe(Research, "research")

    return workflow("simple-example",
        sequence(
            task("research",
                output=Research,
                agent=researcher,
                prompt=f"Research the following topic and provide a concise summary with key points.\n\nTopic: {topic}",
            ),
            task("write",
                output=Output,
                agent=writer,
                depends_on=["research"],
                prompt=(
                    f"Write a short article based on this research.\n\n"
                    f"Summary: {research.get('summary', '')}\n\n"
                    f"Key points:\n"
                    + "\n".join(f"- {p}" for p in research.get("keyPoints", []))
                ) if research else "Waiting for research...",
            ),
        ),
    )


if __name__ == "__main__":
    run(build, outputs=[Research, Output])

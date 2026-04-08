# /// script
# dependencies = ["pydantic>=2.0"]
# ///
from pydantic import BaseModel
from smithers import workflow, task, Agent, run


class Analysis(BaseModel):
    summary: str
    issues: list[str]


mock = Agent("mock")


def build(ctx):
    topic = ctx.input.get("topic", "default")
    return workflow("pydantic-agent",
        task("analyze", output=Analysis, agent=mock,
             prompt=f"Analyze: {topic}"),
    )


if __name__ == "__main__":
    run(build, outputs=[Analysis])

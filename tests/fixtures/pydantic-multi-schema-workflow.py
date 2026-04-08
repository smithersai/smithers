# /// script
# dependencies = ["pydantic>=2.0"]
# ///
from pydantic import BaseModel
from smithers import workflow, task, sequence, run


class Research(BaseModel):
    summary: str
    confidence: int
    notes: str | None = None


class Report(BaseModel):
    title: str
    body: str


def build(ctx):
    return workflow("pydantic-multi",
        sequence(
            task("research", output=Research,
                 payload={"summary": "AI is great", "confidence": 95, "notes": None}),
            task("report", output=Report,
                 payload={"title": "AI Report", "body": "Details here"}),
        ),
    )


if __name__ == "__main__":
    run(build, outputs=[Research, Report])

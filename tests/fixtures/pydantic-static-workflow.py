# /// script
# dependencies = ["pydantic>=2.0"]
# ///
from pydantic import BaseModel
from smithers import workflow, task, run


class OutputA(BaseModel):
    value: int


def build(ctx):
    return workflow("pydantic-static",
        task("t1", output=OutputA, payload={"value": 42}),
    )


if __name__ == "__main__":
    run(build, outputs=[OutputA])

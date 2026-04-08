# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
Gate — Poll a condition until it passes.

Demonstrates: loop with computed condition, ctx.latest with model class.
"""
from pydantic import BaseModel
from smithers import workflow, task, loop, Agent, run


class Check(BaseModel):
    ready: bool
    status: str
    details: str | None = None


claude = Agent("claude")


def build(ctx):
    latest_check = ctx.latest(Check, "check")
    is_ready = latest_check is not None and latest_check.get("ready", False)
    target = ctx.input.get("target", "http://localhost:3000/health")

    return workflow("gate",
        loop("poll",
            until=is_ready,
            max_iterations=10,
            children=task("check",
                output=Check,
                agent=claude,
                prompt=(
                    f"Check if the target is ready.\n"
                    f"Target: {target}\n\n"
                    f"Run a health check and set ready=true if the service is responding."
                ),
            ),
        ),
    )


if __name__ == "__main__":
    run(build, outputs=[Check])

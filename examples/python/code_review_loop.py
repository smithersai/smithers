# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
Code Review Loop — Iteratively review and improve code until approved.

Demonstrates: loop, iteration counting, ctx.latest with model class.
"""
from pydantic import BaseModel
from smithers import workflow, task, sequence, loop, Agent, run


class Fix(BaseModel):
    files_changed: list[str]
    description: str


class Review(BaseModel):
    approved: bool
    feedback: str
    issues: list[str]


reviewer = Agent("reviewer")


def build(ctx):
    review_count = ctx.iteration_count(Review, "review")
    latest_review = ctx.latest(Review, "review")
    approved = latest_review is not None and latest_review.get("approved", False)
    directory = ctx.input.get("directory", ".")

    return workflow("code-review-loop",
        loop("review-loop",
            until=approved,
            max_iterations=3,
            children=sequence(
                task("fix",
                    output=Fix,
                    agent=reviewer,
                    prompt=(
                        f"Analyze the code in {directory} and identify any issues.\n"
                        f"Make improvements to code quality, fix bugs, and clean up style."
                    ) if review_count == 0 else (
                        f"Apply fixes based on the reviewer's feedback:\n\n"
                        f"{latest_review.get('feedback', '') if latest_review else ''}\n\n"
                        f"Directory: {directory}"
                    ),
                ),
                task("review",
                    output=Review,
                    agent=reviewer,
                    depends_on=["fix"],
                    prompt=(
                        f"Review the code changes in {directory}.\n"
                        f"This is review round {review_count + 1}.\n\n"
                        f"Set approved=true if the code is ready to merge."
                    ),
                ),
            ),
        ),
    )


if __name__ == "__main__":
    run(build, outputs=[Fix, Review])

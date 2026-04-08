# /// script
# dependencies = ["pydantic>=2.0"]
# ///
"""
Debate — Two agents argue opposing positions, a judge decides.

Demonstrates: loop, parallel inside loop, conditional prompts, output history.
"""
from pydantic import BaseModel
from smithers import workflow, task, sequence, loop, parallel, Agent, run


class Argument(BaseModel):
    position: str
    round: int
    points: list[dict]
    rebuttals: list[str]
    summary: str


class Verdict(BaseModel):
    decision: str
    winner: str
    reasoning: str
    recommendation: str


claude = Agent("claude")


def build(ctx):
    all_args = ctx.outputs(Argument)
    rounds = ctx.input.get("rounds", 2)
    current_round = len(all_args) // 2 + 1
    debate_complete = current_round > rounds
    question = ctx.input.get("question", "Should we rewrite this service in Rust?")
    context = ctx.input.get("context", "")

    for_args = [a for a in all_args if a.get("position") == "for"]
    against_args = [a for a in all_args if a.get("position") == "against"]

    last_against = _format_points(against_args[-1]) if against_args else None
    last_for = _format_points(for_args[-1]) if for_args else None

    return workflow("debate",
        sequence(
            loop("debate-loop",
                until=debate_complete,
                max_iterations=rounds,
                children=sequence(
                    parallel(
                        task(f"for-round-{current_round}",
                            output=Argument,
                            agent=claude,
                            prompt=(
                                f"You are arguing FOR the proposal.\n"
                                f"Question: {question}\nContext: {context}\n"
                                f"Round: {current_round}/{rounds}\n\n"
                                + (f"Rebut the opponent's points:\n{last_against}" if last_against
                                   else "Opening round. Make your strongest case.")
                            ),
                        ),
                        task(f"against-round-{current_round}",
                            output=Argument,
                            agent=claude,
                            prompt=(
                                f"You are arguing AGAINST the proposal.\n"
                                f"Question: {question}\nContext: {context}\n"
                                f"Round: {current_round}/{rounds}\n\n"
                                + (f"Rebut the proposer's points:\n{last_for}" if last_for
                                   else "Opening round. Make your strongest counter-case.")
                            ),
                        ),
                    ),
                ),
            ),
            task("verdict",
                output=Verdict,
                agent=claude,
                prompt=(
                    f"You are an impartial judge. Question: {question}\n\n"
                    f"FOR ({len(for_args)} rounds):\n"
                    + "\n".join(f"Round {i+1}: {_format_points(a)}" for i, a in enumerate(for_args))
                    + f"\n\nAGAINST ({len(against_args)} rounds):\n"
                    + "\n".join(f"Round {i+1}: {_format_points(a)}" for i, a in enumerate(against_args))
                    + "\n\nRender your verdict."
                ),
            ),
        ),
    )


def _format_points(arg):
    return "\n".join(f"- {p.get('claim', '')}: {p.get('evidence', '')}" for p in arg.get("points", []))


if __name__ == "__main__":
    run(build, outputs=[Argument, Verdict])

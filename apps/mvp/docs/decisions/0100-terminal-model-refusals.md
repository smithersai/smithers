# 0100: Model quota and credit refusals end the answer

Date: 2026-10-25

Will requested that a deployment model's HTTP 402, or quota/credit refusal under HTTP 429, end chat promptly with “Couldn't answer”, a short reason and Retry. A plain rate limit keeps durable backoff. No backup provider is introduced.

Normalize deployment and personal-model refusals through one worker helper. Drop quota/credit cooldown hints, and map HTTP 402 to `out_of_credit` before the model proxy streams it: the proxy wire retains the error code but not the upstream status. The existing agent terminal classifier then ends the answer. The opening judge's existing flow retry policy excludes quota/credit codes; its safe quota flag reaches the durable settlement even before the agent emits progress. The sealed agent failure also supplies that flag, so a crash while settlement retries cannot lose the quota reason. No engine policy or architecture changes are needed.

The deployment's existing daily-budget `quota_exceeded` refusal uses the same quota explanation. Persist `quota` as an answer failure (migration 0059), and bump the synced message schema to version 4. The conversation projects fixed product copy and retains its existing Retry action. Provider text never becomes answer copy. The endpoint records a quota refusal log, span and counter using only role, code and status.

This repairs shared model and answer infrastructure rather than adding a plugin feature. Use the library catalog entries for the model proxy (`@smthrs/model`), durable model step (`@smthrs/agent`), and durable retry policies (`@smthrs/flow`). Regression suites inject faulty model services through the real endpoint and durable engine; the browser spec declares a real refusing-provider requirement on deployments.

---
id: assistant-routes-request
principal: assistant
kind: accepted
task:
  objective: The owner asks for slugify to keep digits between words.
  inputs: [owner message]
  acceptance: [The request is routed to the lead as a task with one accountable role]
  evidence: [the request text]
context: []
expect:
  status: done
  fields: [route, assignee, reply]
---

A clear change request is routed as a task, not answered or asked back.

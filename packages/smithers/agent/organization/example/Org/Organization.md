---
owner: owner
assistant: assistant
rosterDir: Org
skillsDir: Org/Skills
casesDir: Org/Cases
policyFile: Org/Policy/Gates.md
connectionsFile: Org/Connections.md
meetingsFile: Org/Meetings.md
seats:
  default: openai:gpt-6-sol
  light: openai:gpt-6-luna
judge: none
vm:
  provider: microsandbox
  image: node:26-bookworm
  cpus: 2
  memoryMib: 2048
  maxConcurrentVMs: 2
wiki:
  generatedDir: Org/Runs
  statusFile: Org/Status.md
  commit: false
  push: false
---

# Example organization

A four-role example used by tests and documentation. A real installation keeps its
own roster, skills, policies and connections in its private repository.

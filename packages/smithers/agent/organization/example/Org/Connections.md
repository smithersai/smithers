---
connections:
  - { id: chat-assistant, provider: slack, label: Assistant bot, credential: chat-assistant, scopes: [chat:write, im:history], personal: false, containerAliases: { owner-dm: null, team: null } }
  - { id: chat-lead, provider: slack, label: Lead bot, credential: chat-lead, scopes: [chat:write], personal: false, containerAliases: { team: null } }
  - { id: calendar-owner, provider: googlecalendar, label: Owner calendar, principal: assistant, credential: calendar-owner, scopes: [calendar.events, calendar.freebusy], personal: true, containerAliases: { primary: null } }
---

# Connections

Credential references only. Container aliases stay `null` until setup maps them to provider ids.

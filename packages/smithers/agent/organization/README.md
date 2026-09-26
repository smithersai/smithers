# @smthrs/organization

**Documentation:** https://organization.smithers.sh

Agent organizations on Smithers. An organization is a directory of Markdown
role profiles, a pinned skill pack, and evaluation cases. This package loads
and validates them, decides every authority question (grants, hiring, owner
contact, knowledge reads) without a model, composes each role's prompt from
capped and pinned parts, runs the hiring lifecycle, and plans weekly
one-on-ones across daylight-saving changes.

A complete four-role example lives in [`example/Org`](./example/Org/).

- [Overview](./docs/README.md)
- [Quickstart](./docs/quickstart.md)
- [Organization model](./docs/concepts/organization.md)
- [API reference](./docs/api.md)

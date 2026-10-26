# 0111: Full screen preserves the displayed repository revision

A ready repository embed opens Full screen with an explicit revision, even at the default branch's root. RepoApi can resolve the embed before Electric delivers the repository row; using that row to shorten the URL made the destination change as sync arrived. A branch's default status can also change after the embed loads.

Use the embed's displayed revision for this link. Keep ordinary repository navigation's canonical root URLs. Prove sync ordering through the existing injected Effect ShapeSource, holding and then releasing Electric without timers or request interception. No new library is needed: the catalog entries are `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db`.

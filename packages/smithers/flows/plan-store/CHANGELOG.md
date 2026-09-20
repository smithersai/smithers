# @smthrs/plan-store

## [Unreleased]

### Added

- New package. `PlanStore` and `Migrations` moved here verbatim from
  `@smthrs/plan`, so a caller that only compiles a plan no longer installs
  `@smthrs/database`. `@smthrs/core` and `@smthrs/patterns`, which reach plan
  for its effect model, no longer carry a database in their dependency
  closure.

### Changed

- `PlanStore`'s service key is `@smthrs/plan-store/PlanStore` and its error tag
  is `@smthrs/plan-store/PlanStoreError`, matching the package that owns them.
  Both were spelled `@smthrs/plan/...` while the code lived there. The
  migration namespace (`plan`), its id block (`4000`), the three table names
  and every SQL statement are unchanged, so an existing database is read and
  written exactly as before.

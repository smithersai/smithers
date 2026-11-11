// Backend integration fixtures select a native PostgreSQL binary. That
// selector is not CLI configuration; explicit per-test environments still
// exercise the CLI notice contract.
delete process.env.SMITHERS_POSTGRES_TEST_BIN
// An operator's `SMITHERS_MEMORY_DB` outranks every `--root`, so a memory
// test that inherits it writes and deletes facts in the operator's real store.
// Tests that exercise the override bind it to a file they own.
delete process.env.SMITHERS_MEMORY_DB

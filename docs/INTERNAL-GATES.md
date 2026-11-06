# Internal-only gates

`api/crossRepoSync.test.ts` and its hardcoded `SYNC_LOCK_SHA256` belong to the internal portal/wb dual-repository mirror. They are intentionally excluded from this sanitized public snapshot: the export contains intentional path/configuration sanitization and no dual-repository mirror contract. The lock value is not changed or bypassed; it simply does not apply here. Public verification uses clean install, typecheck, build, full tests, secret scan and SBOM/license review.


`api/dataLifecycle.test.ts` uses `describe.skipIf(!HAS_WB_SYNC)`: when the public runner has no `../../wb` sibling directory, the dual-repository lifecycle checks are reported as skipped rather than failing. The public CI log must show this skip explicitly.


`scripts/sync-release-artifacts.test.ts` and `api/lib/releaseFileLock.test.ts` exercise production root ownership, `O_NOFOLLOW`, parent-PID and release-lock behavior. On a non-root public runner they are explicitly skipped; the same CI job then runs both files in a separate `sudo` step, so the privileged behavior is still executed rather than waived. Local non-root runs must report these two skips explicitly.

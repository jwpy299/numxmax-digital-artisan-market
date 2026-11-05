# Internal-only gates

`api/crossRepoSync.test.ts` and its hardcoded `SYNC_LOCK_SHA256` belong to the internal portal/wb dual-repository mirror. They are intentionally excluded from this sanitized public snapshot: the export contains intentional path/configuration sanitization and no dual-repository mirror contract. The lock value is not changed or bypassed; it simply does not apply here. Public verification uses clean install, typecheck, build, full tests, secret scan and SBOM/license review.

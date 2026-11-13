# v2 development checkpoint — 2026-11-13

This is a user-requested development checkpoint, **not a production-ready release**. It preserves the v2 implementation and in-progress review fixes without waiting for local host deployment.

## Implemented / retained

- Schema v8 multi-space storage, closed-turn distillation, hybrid retrieval, tiered injection and lifecycle/Wiki work.
- Evidence binding, true/false numeric confirmation and generic extraction repairs; previous targeted recall results include 92/92 same-day, 82/92 at 20 days, and 78 characters / 1 hit at a 500-character budget.
- Migration snapshot and shutdown/cancellation work is retained but its implementation owner was stopped for this immediate checkpoint; it has **not completed final regression or review**.
- More defensive ignore rules and a read-only installation verifier with explicit v8 requirements.

## Known open items — do not hide these behind earlier green tests

1. The final evidence-denial integration is pending: an explicitly bound body denial can still be overridden by a derived slot hit in shouldDenyRecall. Two new evidence cases exercise this boundary.
2. The v8 DDL currently creates non-STRICT tables although the architecture specifies STRICT; the new installation-verifier fixture exposes this mismatch. First isolated verifier run: 4 pass / 1 fail. Do not weaken that test to claim compliance.
3. WAL backup/race handling, in-flight dispose cancellation, late-write fences and queue restart recovery still require completed targeted tests and independent review.
4. No final complete test run has passed on this exact checkpoint. Earlier independent baseline: 256 tests / 255 pass / 0 fail / 1 skip, before these latest changes.
5. No local production database migration, actual host installation/load verification or host restart was performed. Source publication is separate from deployment acceptance.

## Next validation

Finish the open repairs; run all self-contained tests with a fresh temporary HOME/DSH_HOME per test file, excluding the local production-database test; run the 1000-turn fixture and independent review; only then deploy with a fresh consistent backup and explicit host verification. Do not include real credentials, databases, backups or temporary evidence in Git.

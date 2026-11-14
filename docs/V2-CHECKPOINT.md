# v2 source repair checkpoint — 2026-11-14

This records executed repairs and measured results, not a retroactive plan, release, twelve-capability certification, or production migration. No P0-EXEC.yml covering this turn was found; none was created. The installed 0.1.2 package and private database were not updated. Source package version remains 0.1.2; existing release archives do not contain these repairs.

## Executed repairs

- Evidence-bound body denials now take precedence over derived positive slots. Slot equality lookups also check polarity and available source quotes. Grounded quotes retain conditions across commas and Markdown lists; conditional and unconditional proofs are not deduplicated into one fact. The grounded no-facts/window-recovery compatibility case remains.
- All eight fresh core tables are STRICT. Non-STRICT/mixed v8 databases rebuild transactionally only after a consistent, integrity-checked, fsynced, no-clobber backup. Tests cover all eight tables, original values/storage classes, Unicode, BLOBs, custom indexes/triggers, AUTOINCREMENT high-water marks, repeat opens, foreign keys and failure rollback. Invalid data is refused rather than coerced; an existing migration backup is not overwritten.
- Runtime promises now agree on `^22.16.0 || >=24.0.0`. A memory-only synchronous SQLite transaction-state probe runs before disk access. This run tests Node 24.21.0, not every advertised version.
- New closed turns preempt the five-minute crash-lease timer; requests arriving during a drain trigger another immediate drain. The previously failing capture assertions pass without relaxing them. Abort propagation preserves the caller reason; pre-aborted requests are tested separately from in-flight cancellation.
- Steady derived reads no longer hash/serialize the entire memory table on every getter. Epoch checks include peer data_version, own total_changes() and main.schema_version. Independent review found a publication race; the repair certifies epochs under BEGIN IMMEDIATE before COMMIT, and startup/incremental writes force a locked refresh. Deterministic tests cover peer commits at publication, raw text/facts SQL, DDL, rollback and startup. Narrow independent closure review: 7/7 passed, no remaining blocking finding in that optimization.

## Measured full source regression

Command, run from the source checkout with the bundled Node executable:

```text
node --version
# v24.21.0
node scripts/verify.mjs
# SYNTAX_FILES=28
# TEST_FILES=47
# tests 398
# pass 396
# fail 0
# skipped 2
# duration_ms 171649.2094
# exit code 0
```

Full raw log: `F:/记忆库/临时验证/phase2-final-closure.log`. The runner enumerates every *.test.mjs, uses per-worker temporary DSH_HOME and disables the private live-database fixture. This is the complete enumerated source suite, not an assertion that every architectural requirement has a test.

Skips: (1) optional bigram fallback because jieba was available; separately running `MEMJUDGE_NO_JIEBA=1 node --import ./test/observability-isolation.mjs --test --test-reporter=tap test/retrieval-port.test.mjs` passed 17, failed 0, skipped the mutually exclusive jieba case (18 total, 430.4671 ms, exit 0); (2) private live-database fixture requires explicit opt-in and was not run. Synthetic migration tests remain mandatory and passed.

### Synthetic 1,000-turn fixture in that exact full run

| Measurement | Result | Existing threshold |
|---|---:|---:|
| main database | 217,088 bytes (212 KiB) | <=262,144 bytes |
| WAL | 0 bytes | included below |
| database + WAL/journal | 217,088 bytes | <=262,144 bytes |
| maximum Tier-S + Tier-D | 1,230 UTF-16 chars | <=1,500 chars |
| maximum S / D separately | 330 / 900 chars | existing layer budgets |
| active dynamic recall steps | 266 | >0 |
| 100 mixed queries P50 | 4.323 ms | informational |
| 100 mixed queries P95 | 7.178 ms | <15 ms |
| P99 / maximum | 7.834 / 11.984 ms | informational |

Final fixture: 54 active memories, 6 wiki pages; cumulative 557 demotions, 557 archives and 924 auxiliary-row purges. Another existing local fixture measured 92/92 rows, 615 average returned characters and 1.784 ms average retrieval. R21–R92 repeat the first20 core questions; this is not92 independent questions or the formal SPEC corpus. These are synthetic/test-corpus measurements, not the user database size, real-model accuracy, network API performance, or measured host context tokens.

The full gate did fail during execution: an earlier run had P95 17.234 ms against the unchanged 15 ms threshold. Profiling exposed repeated full-table freshness stamping. No latency threshold, evidence-denial assertion, STRICT requirement, or capture assertion was weakened to pass. Earlier mixed-state runs are not a clean baseline or formal speedup comparison.

## Still open — do not infer completion from a green source suite

- A reproducible, independently audited twelve-capability acceptance package with its required raw evidence is not complete.
- Continuation: no-session/no-explicit-space tool recall now defaults to global only. Explicit `space=all` is still cross-space opt-in, not a new authorization/ACL boundary. Dynamic injection now validates current authoritative source, space, status and final rendered evidence using the shared final-decision policy; conservative source-local technical recovery is not identical to the tool retrieval path and is not a complete natural-language proof system.
- Legacy slots whose stored quotes have already lost conditions cannot be retroactively repaired by checking the remaining quote alone. No private-data re-extraction was performed.
- No minimum-version Node 22.16 runtime matrix, new distribution archive, Git publication of this repair, production migration, actual host restart/load, or real GUI/session-identity acceptance was performed.
- Current-session injection/event UI, Tencent full-platform integration and workbench bidirectional synchronization retain their previously disclosed gaps.

Before deployment, use a separately versioned/verified distribution, preserve a consistent private backup, run migration verification on an authorized copy, and verify the existing host after restart. Never upload credentials, private databases, backups or local logs to Git.

## Continuation — source/space boundaries (2026-11-14)

- Added explicit no-identity/global-only recall tests including cache and access-time boundaries; session cwd/header cwd still resolve project+global. Explicit workspace/global/all remain caller opt-ins.
- Dynamic hits now resolve the current authoritative store row (or an explicitly supplied memory list), never borrow stale/out-of-scope index text when that source is missing. Current text/status/space are rechecked for conflict siblings too.
- Retrieval relevance is not evidence: slot/vector/BM25 routes all use the same final-denial policy before rendering and after truncation. Unsupported candidates are not marked seen; a truncated disputed pair is never partially emitted.
- Independent review reproduced comparator/equality, foreign technical subject, restrictive 仅在 (including formatting), internal/trailing condition and 未将/建议将/future assignment failures in the initial fallback. Counterexamples were added to sync/async tests, and recovery narrowed instead of bypassing evidence-bound denials. The secondary expert summon timed out; fallback reviewer results are identified as agent review, not a completed specialist result.
- The narrow no-facts recovery handles source-local technical owner+literal key+affirmative numeric/symbolic assignment, and grounded name/alias questions. Explicit equality with an unsupported parser stays denied. Internal/trailing conditions, negation and prospective wording are conservatively refused. This can cause false negatives: keyword retrieval remains available, but this is not a claim that every paraphrase/condition or unsupported language is understood.
- Fixed open 什么 questions being misread as explicit value 什 by punctuation/particle stripping. Evidence matching strips paired formatting but preserves stored original text.
- Full continuation acceptance initially found two legitimate narrative false negatives (kind-partition and historical decision/bug recall). Existing assertions were kept. Source-local narrative recovery now requires technical identity, a substantial topical phrase and affirmative recorded action; root-cause queries may omit an uppercase E-prefixed symptom code absent from the distilled source, but remaining technical identities must bind. This returns source wording, not confirmation of an unparsed equality.
- A newer independent narrative review found same-sentence foreign-owner laundering, distant negation/postposed suggestions and an exact numeric question missed by parseSlotQuery. Added sync/async negative controls (first reproduced 8/8 failures), required matching first technical identity and action-prefix identities, refused numeric narrative questions and whole-sentence negative/prospective/comparison modifiers. This is conservative lexical binding, not general subject/tense understanding.
- Latest targeted set: 216 tests, 216 pass, 0 fail/skip. Fresh independent narrow closure: 171/171 pass, no remaining blocker in the reported five counterexample classes. Numeric technical identifiers and sentences with unrelated negative/prospective wording can conservatively lose recall; this limitation is intentional and disclosed.
- Final complete continuation gate: `node scripts/verify.mjs`, Node v24.21.0, exit 0; 29 syntax checks / 49 test files / 563 tests / 561 pass / 0 fail / 2 skip, duration 159564.7102 ms. Two expected skips remain mutually exclusive tokenizer fallback and private-database opt-in. Separate MEMJUDGE_NO_JIEBA=1 retrieval run: 18 tests / 17 pass / 0 fail / 1 opposite-mode skip. Final log: F:/记忆库/临时验证/safety-final-gate.log. Earlier interrupted/failed runs and the superseded 551-test run are not the final evidence.
- Same final full-run synthetic 1000-turn fixture: total SQLite+WAL 217088 bytes (212 KiB), max S/D/total 330/900/1230 chars, 266 active recall steps. Mixed-query latency P50/P95/P99/max = 5.296/8.049/10.479/10.522 ms against unchanged P95<15 ms. The existing local fixture measured 92/92 rows, average 615 chars / 1.704 ms; R21–R92 repeat the first20 core questions, so these are not92 independent questions or formal SPEC corpus results. These are fixture measurements, not private-database size, real-model accuracy or host tokens.
- No active installation/profile/private database changes, no package/release update and no Git publication in this continuation.

## Development evidence collector — measured execution (2026-11-14)

- Added `scripts/capability-evidence.mjs` and `evidence:capabilities`: runs24 fixed unique local test files once each, retains complete stdout/stderr TAP logs with SHA-256/byte inventory, maps results to12 dimensions without generating formal acceptance or signatures. New unit suite:17/17 pass,0 fail/skip, independently rerun by read-only fallback reviewer after specialist summon timeout.
- Actual run: `node scripts/capability-evidence.mjs --out-parent F:/记忆库/临时验证`; output `F:/记忆库/临时验证/memjudge-development-evidence-OdiXCB`.24 log artifacts /105436 bytes /86 source hashes;373 tests /371 pass /0 fail /2 skip; sum of per-suite durations124711 ms.22 suites pass,2 partial; dimensions7 and11 partial, all12 formalAcceptance:null. `regressionPassed:true` means no failed local suite, NOT zero skipped tests or formal acceptance.
- Separate `--verify` exit0:24 artifacts,12 dimensions,sourceMatchesCurrent:true,formalAcceptance:false. Independent reviewer read all24 logs and recomputed24 artifact hashes+86 source hashes (110/110 match). Only the before inventory is persisted; sourceStable records the in-process before/after comparison, not two separately persisted snapshots. Hashes are not authenticated signatures.
- Final workspace gate: `node scripts/verify.mjs`, Node v24.21.0, exit0;29 syntax files /50 test files /580 tests /578 pass /0 fail /0 cancelled /2 skip /0 todo;53319.9709 ms test duration. Log: `F:/记忆库/临时验证/capability-evidence-full-gate.log`. Skips remain mutually exclusive jieba fallback and private DB opt-in (disabled).
- Same gate synthetic1000-turn fixture:217088 bytes main+WAL (WAL0), max S/D/total330/900/1230 UTF-16 chars;100 mixed queries P50/P95/P99/max1.140/1.753/3.302/3.623 ms; unchanged P95<15 ms threshold. This is not the SPEC20-chapter204800-byte storage protocol.
- QA audit confirms formal mem-eval public runOne/runDecay throw `Evaluation execution disabled: isolated runner is not implemented`; adapter forwarding target is absent, and SPEC versus scorer denyNearEntity behavior has drifted. No guard bypass, scorer edits or fixture substitutions. Local92 rows contain repeated questions; earlier scores are not92 independent formal questions. See `docs/CAPABILITY-EVIDENCE.md`.
- This turn found no P0-EXEC.yml, created no retrospective planning files, changed no active install/profile/private DB, made no Git commit/push and built no release package. Twelve formal capabilities and real-session GUI acceptance remain pending.

# Backend practices playbook

Use this for a review with `project.kind: "backend"`. It covers servers, APIs, CLIs, workers, data access and the code around them. There are no screenshots. The evidence for a fix is the code change plus something that proves it: a failing-then-passing test, a command and its output, or a measurement. The steps for recording things are in `SKILL.md`.

Audit and report first. Fix only the issues the user approves (see "Report first, fix only when told" in `SKILL.md`). While reporting, you may run the existing tests and tools, and write throwaway reproductions outside the repo. Don't change the project.

## Companion skills (wshobson/agents)

They ship with review-kit. `review-kit companions --kind backend` shows where they are. Read the ones that fit the code before auditing:

| Skill | Read it for |
| --- | --- |
| `api-design-principles` | HTTP and CLI interfaces: resource naming, status codes, error shape, pagination, versioning. |
| `architecture-patterns` | Layering, dependency direction, module boundaries, where business rules live. |
| `error-handling-patterns` | Error propagation, failure modes, retries, timeouts, graceful degradation. |

Cite them in the issue details when they back a finding, for example `Practice (error-handling-patterns): fail fast on invalid input at the boundary.` They are general guides. The repo's own conventions and the user's instructions win where they differ.

## What to check

Read the entry points first (routes, CLI commands, handlers, jobs), then follow the data inwards.

1. **Security.**
   - Input is validated at the boundary.
   - No injection: SQL, shell, path traversal, template or header.
   - Authentication and authorisation are checked on every route, including object-level checks so one user can't read another's data.
   - Secrets aren't in code or logs.
   - Safe defaults: bind to localhost, set limits, deny by default.
   - Dependencies have no known CVEs. Use OWASP ASVS and the API Security Top 10 as the reference.
2. **Correctness.**
   - Edge cases: empty, huge, unicode, concurrent.
   - Off-by-one errors, time zones, float money.
   - Races and check-then-act.
   - Idempotency of retried operations.
   - Transactions around multi-step writes.
3. **Errors and failure modes.**
   - Errors aren't swallowed or turned into silent success.
   - Error messages are useful but don't leak internals.
   - Timeouts on every network call. Bounded retries with backoff.
   - A clear exit code or status for each failure.
4. **Interface design.**
   - Consistent names and shapes.
   - Correct status codes or exit codes.
   - Stable, documented error format.
   - Pagination and limits on lists.
   - Backwards compatibility for anything already published.
5. **Data.**
   - Schema constraints match the code's assumptions.
   - Migrations are safe to run on live data.
   - No N+1 queries, and indexes exist for real queries.
   - Atomic writes for files: write a temp file, then rename.
6. **Architecture.**
   - Dependencies point inwards.
   - No cycles.
   - Business rules aren't spread across handlers.
   - Each module has one job.
   - Global state and hidden I/O are kept to the edges.
7. **Performance and resources.**
   - Unbounded memory: reading whole files, huge arrays.
   - Blocking calls on hot paths.
   - Files, sockets and processes are closed.
   - Caching has invalidation.
8. **Tests.**
   - Risky paths have tests, including failure paths.
   - Tests are deterministic.
   - No test depends on the network or the real home folder.
9. **Operability.**
   - Logs are structured where it matters, with no secrets.
   - Config comes from the environment or flags, with validation.
   - A health or version check exists.
   - Graceful shutdown.
   - Any README setup steps actually work.

Run what the project already has, and record the results as evidence: the test suite, linters, type checkers, `pip-audit` or `npm audit`. Don't add new tooling the project didn't ask for.

## Recording

- **Areas** are modules or layers, for example `serve`, `cli`, `storage`. Create them with `add-issue --area <id>`, or add `areas` entries to `review.json`.
- **`--where`** is `path/file.py:123` for every issue.
- **Severity:**

  | Severity | Use for |
  | --- | --- |
  | P0 | Exploitable security holes, data loss or corruption, crashes on normal input. |
  | P1 | Wrong results on realistic input, missing authorisation or validation, unbounded resource use, error handling that hides failures, missing tests on risky code. |
  | P2 | Maintainability, consistency, clarity, small performance wins. |

- **Fixes**, once approved, use `add-fix` without `--pair`. Put the evidence in `--summary` as Markdown:

  ````markdown
  **Problem.** `serve` read the whole request body into memory, so a 2 GB upload exhausted RAM.

  **Change.** Cap the body at 10 MB and stream to disk.

  **Proof.** New test `test_upload_limit` fails before the change and passes after:

  ```
  $ python3 -m unittest tests.test_serve -k upload
  Ran 1 test ... OK
  ```
  ````

- Pass `--files` and, once committed, `--commit <sha>`. Prefer adding a regression test to each fix. If a fix can't have a test, say how you verified it.
- Record design debt that is bigger than one fix as plan items with `add-plan`. Don't log twenty separate P2 issues for it.

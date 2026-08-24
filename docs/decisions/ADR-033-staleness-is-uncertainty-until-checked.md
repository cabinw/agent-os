# ADR-033: Staleness Is Uncertainty Until Checked

Status: accepted

## Context

Long dormancy makes dependencies, APIs and credentials risky, but elapsed time
cannot prove that any concrete item is broken. Generic measurements and task
titles also cannot carry a stable environment-verification contract.

## Decision

A dormant Revival report starts with exactly three sourced `likely-stale`
categories: dependencies, APIs and credentials. This wording is uncertainty,
not a failure claim.

`project.environment.checked` records one or more unique category results:

```
{ checks: [{ area, status: current | stale, detail }] }
```

The latest result per category replaces `likely-stale`. The event cannot record
`likely-stale`; only an actual check may emit it, and each result is therefore a
fact with its event id. Unchecked categories remain uncertain. Check details
describe outcomes and must not contain credential material.

`project.revived` and `project.environment.checked` are excluded from the
dormancy clock. Generating or verifying the report does not itself mean work on
the project resumed.

## Alternatives

**Infer concrete failures from age.** Rejected: age is evidence of uncertainty,
not breakage.

**Use `measurement.recorded`.** Rejected: it has no environment category or
current/stale semantics.

**Parse an environment task title or prose.** Rejected: localized free text is
not a protocol.

## Consequences

- The UI must visually distinguish likely, verified-current and verified-stale.
- Partial checks are valid and leave other categories likely stale.
- Later checks replace earlier facts per category while retaining source ids.
- Credential verification records status and sanitized detail, never secrets.

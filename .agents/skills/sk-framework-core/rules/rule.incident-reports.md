# rule.incident-reports

Inspect with `sidekicks framework show rule.incident-reports`; toggle with
`sidekicks framework disable rule.incident-reports` or `sidekicks framework enable rule.incident-reports`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

### Incident reports — one document under the affected scope

Any incident investigated for a project or service — outage, 5xx regression, data defect, failed
export/job, bad migration — gets a **written report committed under the affected scope's artifacts
base**. Never chat-only, never a Jira comment only. Applies to post-hoc reviews of an
already-shipped fix, not just live firefighting.

| Affected scope | Report path |
|---|---|
| One service | `<service-root>/artifacts/runs/incident-reports/<slug>-<YYYYMMDD>/incident-report.md` |
| Project-wide / multi-service | `projects/<project>/artifacts/runs/incident-reports/<slug>-<YYYYMMDD>/incident-report.md` |

`<service-root>` is the **service root** (`sidekicks scope artifacts-base`) — never its `src/`, and
never the code repo. `<slug>` names the failing surface (endpoint, job, table); `<YYYYMMDD>` is the
date of the **event**, not of writing (Asia/Bangkok). Supporting evidence — logs, captured SQL,
query output, screenshots — sits in the same folder, portable paths only.

Required sections: TL;DR with a severity/owner findings table; impact **and blast radius, including
what was *not* affected**; timeline with absolute Asia/Bangkok timestamps; root cause; why
unaffected branches/environments were unaffected; resolution **plus rejected alternatives and why**;
verification evidence (Rule 5 — reproduced, never asserted from a commit message or ticket);
outstanding actions with owners; lessons. Where the fix's own commit message or the ticket states
something inaccurate, correct it in the report rather than propagating it. State unmeasurable facts
(time-to-detect, reporter) as gaps instead of estimating them.

Then register the durable one-line lesson with `sidekicks memory add --type=context` referencing the
report path — the report holds the narrative, memory holds what a future agent must not re-learn.


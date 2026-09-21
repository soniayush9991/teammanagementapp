# 17. Future enhancements

Beyond the roadmap, roughly in order of expected value.

## Planning intelligence

**Estimate calibration.** The system already stores estimated versus logged
hours on every task. That is enough to tell a team "your estimates run 35% low
on backend work", which makes every subsequent capacity number more honest.
This is the highest-value follow-on precisely because it improves the metric
everything else depends on.

**Scenario planning.** Fork the current plan, move work around, compare the
outcome, then apply or discard. Managers reason in "what if" and currently have
to do it in their heads.

**Automatic rebalancing suggestions.** When someone crosses 100%, propose the
specific moves that would fix it, ranked by skill fit and deadline risk — the
recommender already computes everything required.

**Dependency-aware scheduling.** Use the dependency graph to compute the
earliest feasible start for each task and flag deadlines that are already
impossible.

## Collaboration

- Rich text with code blocks and syntax highlighting.
- Voice and video handoff to an existing provider rather than rebuilding it.
- Threaded task discussions that link a conversation to a task bidirectionally.
- Scheduled and recurring messages for standups and reminders.
- Guest access scoped to a single group, for contractors and clients.

## Integrations

| Integration | Value |
|---|---|
| Calendar (Google, Outlook) | Two-way sync so meetings consume capacity like tasks do |
| Git (GitHub, GitLab) | Move a task on merge; link branches to keys |
| CI | Surface failures against the task that caused them |
| HRIS | Leave and headcount flow in rather than being re-entered |
| Slack and Teams | Bridge notifications for teams that will not switch chat tools |
| Webhooks and a public API | Let customers build what we will not |

## Analytics

- Burndown and burnup per team and per milestone.
- Cumulative flow, to show where work actually queues.
- Utilization trends over quarters for headcount planning.
- Anonymised benchmarks across teams, presented carefully: the point is to
  find a struggling team, not to rank individuals.
- Scheduled report delivery by email.

## Platform

- **Legal hold** exempting specific conversations from retention — the most
  likely enterprise blocker for the current 365-day policy.
- Conversation export for compliance, in a defensible format.
- Customer-managed encryption keys.
- Data residency by region.
- A read replica for reporting, so a heavy export cannot affect the board.
- Native mobile applications, if PWA adoption plateaus.

## Deliberately not planned

| Not building | Why |
|---|---|
| Timesheets and billing | A different product with different buyers; work logs exist for burndown, not invoicing |
| Performance review tooling | Utilization data must not become a performance ranking; conflating them would make people game their estimates and destroy the data |
| Generic no-code workflow builder | Every product that adds one becomes a workflow tool with a team-management module attached |
| Video conferencing | Commodity, well served, expensive to do badly |

The second row is the important one. The moment capacity data is used to
rank people, its inputs stop being honest — and an honest capacity number is
the entire premise of this product.

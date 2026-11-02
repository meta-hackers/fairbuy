# Discovery latency

## Avoiding unnecessary passes (#14, partial implementation)

The stopping rule used to count every soft constraint, including the
`uninterpreted_*` placeholders generated for free-text requirements. A request
such as “comfortable keyboard” could therefore force all three passes even when
four grounded, eligible products were already available. More research cannot
make these placeholders machine-checkable.

The stopping rule now excludes only uninterpreted soft constraints from its
match ratio. Structured preferences with missing evidence still count as
unmatched. Hard failures remain excluded by ranking, and uninterpreted
requirements retain their unknown outcome. Ranking, grounding, streaming and
reasoning effort are unchanged.

### Reproducible measurement

Run `npx vitest run backend/test/providers.test.ts`. The regression test
“stops after one pass with four grounded products and an uninterpreted
preference” supplies the same four grounded products on each mocked pass:

| Metric | Before | After |
| --- | --- | --- |
| Research passes | 3 | 1 |
| Research + extraction API calls | 6 | 2 |

This measures avoided work, **not live wall-clock latency**. Provider latency,
quality across categories and production percentiles have not been measured.
The wider issue #14 remains open: live watch, laptop and appliance baselines,
queue/persistence/image timing and p50/p95 targets still need validation.

### Logs

Existing `discovery.research.completed` and `discovery.extraction.completed`
events expose per-pass durations. `discovery.pass.completed` now also records
the acceptable product count. `discovery.run.completed` records:

- `passes`: research passes started;
- `eligible` and `acceptable`: counts before and after the soft-match threshold;
- `firstEligibleProductMs`: time from provider discovery start to the first
  eligible product being merged, or null if none was found. This excludes queue
  wait and is not a measure of browser-visible latency;
- the existing total duration, source count and timeout flag.

No request text or product evidence is added to these logs.

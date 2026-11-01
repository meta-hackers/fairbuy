# Discovery: time-aware acceptance

## The idea

FairBuy should show useful products promptly rather than keep searching for a perfect shortlist. As a search takes longer, it becomes more willing to **stop with imperfect soft-preference matches**, without lowering reasoning effort or weakening hard requirements.

There are three separate decisions:

1. **Can this offer be considered?** Evidence checks and hard exclusions determine eligibility.
2. **Should this product appear now?** Every grounded product with an eligible offer appears as soon as it is validated and persisted, even if it is an imperfect match.
3. **Is the shortlist good enough to stop researching?** A time-dependent soft-match threshold determines whether another research pass is worthwhile.

The threshold controls the third decision, not the second. It never hides a useful first result while FairBuy searches for something better.

## What time changes

Let `t` be elapsed milliseconds since the live discovery worker starts its provider run:

```text
minimumSoftMatch(t) = max(0, 0.75 × (1 − max(0, t) / 90000))
```

| Elapsed time | Minimum supported soft preferences to count toward stopping |
|---|---:|
| 0 seconds | 75% |
| 30 seconds | 50% |
| 45 seconds | 37.5% |
| 60 seconds | 25% |
| 90 seconds or more | 0% |

These are acceptance-policy values, **not factual confidence, product quality, or the displayed fit score**. The formula is a practical stopping rule, not a prediction of the value of the next search result. Subtracting the same elapsed-time penalty from every product's ranking would not change their relative order; lowering the stopping threshold instead changes whether continued searching is justified.

### Calculating a product's soft match

The server evaluates each eligible offer using the existing deterministic constraint engine:

```text
softMatch(offer) = soft constraints that pass / all soft constraints
```

- Each soft constraint has equal weight for this stopping rule.
- Failed and unknown soft constraints remain in the denominator; neither counts as a pass.
- A soft budget is included. A hard budget is an eligibility constraint instead.
- Learned preferences are included through the effective configuration.
- If there are no soft constraints, every eligible offer qualifies immediately.
- A product counts if at least one of its eligible offers meets the current threshold. Several sellers of one model still count as **one product**; preferences are not combined across different sellers' offers.

For example, an offer with two supported preferences out of four has a 50% soft match. It can appear immediately, but it only starts counting toward the stopping target after 30 seconds. Its displayed ranking score does not increase merely because time has passed.

## Research and stopping flow

The live provider runs at most **three research/extraction passes** in a discovery round:

1. Re-evaluate the current products using the current elapsed time. If four distinct products qualify, do not start another pass.
2. Choose a search strategy and pass the threshold, existing products, exclusion reasons, and shopping context to the research model.
3. Research real sources, then extract structured products from that research.
4. Validate and ground each complete streamed product, merge duplicate models/offers, persist progress, and recompute rankings. The browser shows eligible cards on its next poll; it does not wait for four products or the end of extraction.
5. After the pass, repeat the stopping check with updated elapsed time. Stop after three passes even if the target has not been reached.

The first research call targets **one useful candidate**, not the entire ideal shortlist. Later calls target four candidates and seek complementary models. These targets guide research; extraction can retain other grounded products already found.

### Search strategies

| Strategy | When a new pass starts | Behavior |
|---|---|---|
| `quick_start` | First pass, before 45 seconds | Find an initial source-backed candidate and return compact evidence promptly. |
| `focused` | Later pass, before 45 seconds | Seek stronger soft matches to complement the visible options. |
| `broader` | From 45 seconds until 90 seconds | Stop using soft preferences and a soft budget as strict search filters; describe compromises. |
| `best_available` | From 90 seconds onward | Seek relevant, eligible alternatives even when they miss most soft preferences. |

The default Meta research prompt receives this policy explicitly. In optional Brave mode, broader queries omit soft requirement labels and a soft budget while retaining core purpose, location/currency, and hard requirement labels. All extracted offers still go through the same grounding and deterministic eligibility checks.

### Source hints

Each round also computes a **source plan** from the brief's category and country. The plan suggests a small number of seller/marketplace domains plus specification, review and comparison references. It is guidance, not evidence and not an allowlist:

- The broad query is unchanged, so an incomplete plan cannot narrow the search to nothing.
- In Brave mode, a second targeted `site:` query runs in parallel when the vertical is known; a failed targeted query does not discard the broad result.
- Specification, review and comparison domains (for example Open Icecat) may support attributes, but they are rejected as offer URLs and price sources by extraction and normalization.
- The plan does not change ranking, hard checks or source-grounding rules.
- The database catalog is seeded from `data/source-catalog.ts` and editable in the [backoffice](BACKOFFICE.md#discovery-source-catalog); changes apply to the next round.

See [category-aware source hints](SOURCES.md).

## What time never changes

- **Research reasoning effort:** `DISCOVERY_REASONING_EFFORT` remains configured throughout the round. Mechanical extraction remains at its separate, fixed `low` effort.
- **Known hard failures:** offers that fail an explicit must-have or hard budget remain excluded.
- **Other exclusions:** sold-out offers, wrong-currency offers, and discarded models do not become acceptable just because the search is slow.
- **Evidence requirements:** offer URLs must be returned research sources, and accepted quotes must occur literally in the research. Unknown information must not be invented.
- **The person's brief:** broadening the search does not rewrite saved configuration or change a must-have into a preference.
- **Displayed ranking:** elapsed time is not an input to the ranking score. Rankings can still change when new products or evidence arrive.

An unknown hard check is not a verified pass. Under the existing ranking policy, it can remain eligible but visibly **unverified**; elapsed time does not upgrade that status. Core-purpose relevance is instructed in the research prompt, not proven by the numerical soft-match fraction. Source grounding establishes provenance, not independent factual verification.

## Limits and timing caveats

- **90 seconds is not a deadline.** The worker checks time between provider calls/passes; it does not interrupt a running request when the threshold changes.
- Time includes live research, extraction, and progress persistence, but not time spent queued before the provider run begins. The UI's overall elapsed indicator can therefore differ from the acceptance-policy clock.
- Four products are a target, not a guarantee. After three passes, FairBuy retains the grounded eligible results it has, including below-threshold alternatives. If fewer than four eligible models were found, the summary explains the shortfall rather than inventing offers.
- A slow in-flight research call can still delay the first result. This policy improves search objectives and stopping decisions; it does not guarantee provider latency.
- Already-persisted results remain visible if a later provider request fails. Explicit offline demo mode uses its scripted catalog rather than this live search policy.

## Implementation and tests

- [`backend/src/ai/provider.ts`](../backend/src/ai/provider.ts): `discoveryPolicy`, `acceptableProductCount`, the bounded discovery loop, Brave query construction, and non-seller source rejection.
- [`backend/src/ai/prompts.ts`](../backend/src/ai/prompts.ts): research strategies, compact first-result instructions, source-plan usage, and explicit trade-off disclosure.
- [`packages/core/src/sources.ts`](../packages/core/src/sources.ts): vertical classification, seed validation, source plan, and host-role checks.
- [`data/source-catalog.ts`](../data/source-catalog.ts) and [`scripts/seed-source-catalog.ts`](../scripts/seed-source-catalog.ts): reviewed seed data and the database import script.
- [`backend/src/ai/meta.ts`](../backend/src/ai/meta.ts): configured research reasoning effort.
- [`packages/core/src/ranking.ts`](../packages/core/src/ranking.ts): deterministic constraint evaluation, exclusions, and displayed ranking scores.
- [`backend/src/shopping-service.ts`](../backend/src/shopping-service.ts): incremental persistence and ranking of streamed results.
- [`frontend/src/App.tsx`](../frontend/src/App.tsx): polling and rendering products before the round completes.
- [`backend/test/providers.test.ts`](../backend/test/providers.test.ts): threshold boundaries, unchanged reasoning, immediate imperfect results, elapsed-time stopping, hard failures, and Brave query broadening.

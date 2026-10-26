# FairBuy

**Choose the best purchase, not just the lowest price.**

FairBuy is a personal shopping assistant concept: it compares feasible options based on total cost, compatibility, and fit with a person’s preferences. It distinguishes verified facts from seller claims, shows sources and uncertainty, and leaves the final decision to the user.

> **Status:** concept and documentation only; this is not a working application and does not show current offers. All example figures are synthetic. No purchases, seller contacts, or bookings are made.

## Proposed MVP

A focused comparison of new and used electronics in one city, starting from URLs or screenshots submitted by the user. Structured extraction (using Meta vision only after access has been verified), normalized specifications, deterministic feasibility filtering, and an explainable ranking. Use one legitimate live connector if genuinely available; otherwise use clearly labeled fixtures.

The full proposal covers flows, architecture, schema, security, a three-minute demo, a synthetic comparison table, acceptance criteria, adversarial cases, and a ten-day plan: [read the proposal](docs/PROPOSAL.md).

## Principles

- **Feasibility before scoring:** hard constraints (compatibility, maximum budget, schedule) eliminate options that cannot work.
- **Total cost and suitability:** delivered price, applicable charges, warranty, returns, support, and relevant costs/risks.
- **Visible provenance:** source, retrieval time, availability, currency, confidence, and missing data.
- **AI assists, but does not decide:** the model extracts and clarifies; deterministic rules filter and rank. Users can correct the data.
- **No irreversible actions:** no checkout, seller messages, or automatic bookings.

## Product vision

Beyond the MVP, the vision includes new goods, used goods, door-to-door flights, and food delivery. These are future verticals, not promised integrations. For flights, departures that violate constraints are excluded first; for food, the same basket is compared while respecting actual coverage and applicable promotions. See [the proposal](docs/PROPOSAL.md#2-product-verticals) for details and limitations.

## Documentation and GitHub

For a high-level view of the expected system, see [Architecture](Architecture.md).

The README and `docs/` are the source of truth: versionable, readable outside GitHub, and reviewable through pull requests; application code can live alongside them later. A Wiki has history separate from the repository and a less natural review workflow; availability for private repositories depends on the plan. Organization Projects are planning views, not documentation. Pages, Discussions, Issues/Projects, and an organization profile can be considered later without automatically creating sites, wikis, or boards. See [documentation choices](docs/PROPOSAL.md#12-github-documentation).

## Meta hackathon

The “Build for Your World” theme fits an assistant that turns everyday constraints into understandable choices. Models, partner credits, the deadline, and required checks are covered: with sources and caveats: in the [hackathon section](docs/PROPOSAL.md#10-meta-hackathon-and-inference-providers). Participation and team eligibility are not assumed.

## Status and contributions

This repository contains project documentation only; it is not a commitment to release. Before implementation, validate data access, terms of use, account/model access, privacy, event rules, and connector feasibility. Do not add credentials, personal data, or unverified offers.

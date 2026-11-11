# Shopping copy inventory

Copy pass for [issue #15](https://github.com/meta-hackers/fairbuy/issues/15).
Scope: Ask, Configure, Discovery, their shared chrome and draft classifier.
Buy and the Learn dialog retain their task-specific instructions.

## Screen priorities

| Screen / state | Primary instruction | Primary action |
| --- | --- | --- |
| Ask, collecting details | What are you looking for? Include use and budget. | Send message / Send answer |
| Ask, ready | Review the collected brief. | Continue to Configure |
| Configure | Review your brief, then find products. | Find products |
| Discovery, running | Compare results as they arrive. | Read cards and evidence; selection waits for completion |
| Discovery, complete | Compare products; choose what fits. | Purchase options on the chosen card |
| Discovery, empty / failed | Explain what was missing or failed. | Review my brief / Refresh search |

Editing, feedback, source inspection and steering remain secondary actions.
Instructions belong beside their controls, not in extra promotional cards.
Dynamic assistant messages, research activity and product descriptions are data,
not fixed UI copy; they remain unabridged.

## Inventory and decisions

Grouped rows cover the fixed copy surfaces, including conditional states. Field
labels, option values and accessible control names remain unless noted.

### Shared surfaces (`App.tsx`, `LocationBar.tsx`)

| Surface | Decision / reason |
| --- | --- |
| Brand, skip link, Ask / Configure / Discovery / Learn / Buy navigation, New search | Keep: identity, navigation and keyboard access. |
| Header tagline and footer slogan / signoff | Remove: repeat the page's purpose without helping the next action. |
| Stage headings | Keep Ask's short brand heading; make Configure and Discovery task-oriented. |
| Scripted preview banner, fictional offer warnings | Keep visible: users must not mistake demo data for current offers. |
| Loading, Reconnect, password form, setup warning, dismissible errors | Keep: specific entry, recovery and deployment instructions. |
| Location summary, Use my location, Set / Change location, country/city/currency labels, Save / Cancel and geolocation feedback | Keep: optional location controls and actionable permission/failure states. No exact-address request. |
| Privacy, evidence & how it works | One shared expandable disclosure on every stage. Keep provider, draft-transmission, image-proxy, location, retention, diagnostics and deletion details. |
| Evidence limits | Consolidate generic caveats here: extraction is not independent verification; prices/stock may be stale; coverage and quality/safety are not guaranteed; shipping/delivery excluded; check seller terms. |

### Ask (`Chat.tsx`, `Brief.tsx`, `InstantClassifier.tsx`, Ask section of `App.tsx`)

| Surface | Decision / reason |
| --- | --- |
| Welcome question and supporting sentence | Keep one question; shorten support to use and budget. Remove conversational reassurance. |
| Composer label, example placeholder, Send message, thinking state | Keep: accessible input name, concrete example, submission and progress. |
| Guided question legend, options, Other (optional), Send answer, free-text alternative | Keep: explain the two answer mechanisms, not the app's philosophy. |
| Continue to Configure | Keep. Remove ready-state paragraph repeating that the brief remains editable. |
| Missing-fields message after the question cap | Keep: identifies exactly what prevents continuation. |
| Three principles cards | Remove: repeat asking first, sources and user control. Relevant factual limits remain in the disclosure. |
| Brief eyebrow and introductory tagline | Remove. Rename heading to “Your brief”. |
| Brief fields, requirement chips, ready state, missing details | Keep: a live summary, not another explanation. Replace reassurance with “Details to complete”. |
| Classifier loading status, chips, evidence tooltip, clarification | Keep at most three distinct chips in existing priority order. Deduplicate case-insensitive display text; retain clarification even with no chips. Preserve evidence and firm/must-have qualifiers. |

### Configure (`Configure.tsx`, `PriceRange.tsx`, compact `Chat.tsx`)

| Surface | Decision / reason |
| --- | --- |
| Form eyebrow, decorative subheading and repeated step number | Replace with “Search details”; page heading and step navigation already explain the stage. |
| Category, country, use, currency labels / placeholders | Keep: required configuration controls. |
| Country helper | Keep with `aria-describedby`: country changes currency when supported. |
| Price range, optional marker, min/max slider handles, displayed amounts and clear/widen actions | Keep: explain an optional control and its bounds. Remove numeric text inputs; the two keyboard-accessible slider handles are the only price inputs. |
| Budget hard-limit checkbox | Keep explicit: distinguishes a constraint from a preference. |
| City / region optional, no-exact-address note | Keep beside the field: privacy guidance needed at input time. |
| Requirements heading, preference / must-have helper, priority select, Remove, interpretation-unconfirmed note | Keep: explain hard vs soft constraints and unconfirmed interpretation. |
| Add requirement label / placeholder / Add | Keep: accessible name and entry action. |
| Bottom reassurance and aside note about refining later | Remove: no additional decision or field help. |
| Find products | Keep as the search action. |
| Compact chat heading, example, Update brief | Shorten to “Update in your own words” and one example; remove repeated assistant label and explanatory sentence. |
| Previously learned feedback | Keep when present: persisted search context. |

### Discovery (`App.tsx`, `DiscoveryActivity.tsx`, `ProductCard.tsx`, `PreviousResults.tsx`)

| Surface | Decision / reason |
| --- | --- |
| Toolbar count, category, country, round, duration, source count | One compact summary. Remove promotional “worth a closer look” wording and separate completed-duration paragraph. |
| Edit brief / Refresh search | Keep as secondary controls and recovery actions. |
| Searching panel | One queued/running heading; one sentence that results can be compared while searching. Remove repeated counts, timer, search-target paragraph and internal context counters. Timing remains in toolbar. |
| Research activity / history | Keep expandable history and current live status: explains actual work, not generic app behavior. |
| Saved-feedback notices, stale brief warning, failed search and retry text | Keep visible: users need current state and recovery steps. |
| Ranking warnings | Keep specific limitations; existing filtering of a duplicated preference warning is unchanged. |
| Product name, summary, fit reason, score, constraint/unknown-price tags, price range, offer count | Keep: comparison and uncertainty information. |
| Trade-offs & evidence, score breakdown, seller evidence / links | Keep product-specific details expandable. Move repeated quality/safety and shipping caveats to shared disclosure. |
| Purchase options / Not for me | Keep: choose a product or give product-specific feedback. |
| Too few results and empty-state heading / explanation / Review my brief | Keep specific counts, retrieval/grounding/exclusion distinctions and concrete next steps. |
| Why these results, exclusion/drop reasons, searched-page note | Keep: explains why an individual option is missing; opens automatically when no visible options remain. |
| Specific-product question, name/reference input, Why isn’t it here?, answer and next steps | Keep: targeted explanation, distinct from changing a search. |
| All research sources | Keep expandable with count and source links. |
| Learn callout eyebrow, heading, paragraph and generic feedback button | Remove: duplicates the Learn navigation and steering form. Product feedback remains on cards. |
| Previous results, archived status and reasons | Keep: search continuity and explanations of past exclusions. |
| Feedback history / Undo | Keep: inspect and reverse persisted feedback. |
| Steer your results, help, example, Update results | Keep one help sentence describing a new search with the existing brief; style action as secondary to product selection. |
| Refinement micro note | Remove saved-feedback reassurance. Show “Submit when this search finishes” only while submission is blocked by research. |

## Accessibility and review

- Preserve input labels, question legends, live conversation/research/error states,
  country and refinement description IDs, and field-specific uncertainty notices.
- `e2e/copy.spec.ts` checks the three stages, disclosures, accessible descriptions,
  missing description targets, primary controls and horizontal overflow on desktop,
  390px mobile and 320px mobile. The classifier tests cover deduplication and the
  three-chip limit without changing confirmed brief state.
- Reviewed rendered Ask, Configure and Discovery screenshots at 1280px, 390px and
  320px. Task controls remain legible; removed blocks no longer separate users
  from the next task. Shared disclosure stays collapsed until requested.
- Validation: build/typecheck passed; 374 unit tests passed (15 skipped). The
  initial 31 copy, classifier and shopping browser checks passed; after removing
  numeric price inputs, all 40 selected copy, location, slider and shopping checks
  passed across the three viewport projects. Searches used scripted demo data or HTTP mocks; no live
  provider calls or paid latency benchmarks were needed.
- This is an implementation and heuristic usability pass, not a participant
  usability study. Dynamic live-provider prose has not been evaluated here.

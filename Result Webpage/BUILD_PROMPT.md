# Build Prompt — Election Results Demo Site

Paste this into Claude (Code) to kick off the multi-agent build. It assumes the agent runner has file access to this folder (`Result Webpage/`) — all paths below are relative to it.

---

## Context

Build a static, read-only election-results demonstration website. It reads pre-baked CSV/JSON data and renders a choropleth map plus results pages for a fictional general election and referendum, gated by real wall-clock time (results only show once their `declared_at`/etc. timestamp has passed).

**Ground truth**: [`FEATURE_SPEC.md`](FEATURE_SPEC.md) in this folder is the complete, verified data contract and business-logic spec — every rule, algorithm, file schema, and edge case referenced below is defined there. **Read it in full before writing any code.** Do not re-derive rules from the raw CSVs; the spec has already resolved ambiguities the raw files alone don't answer (e.g. which column is the seat key, how derived seats work, the two-stage proportional allocation).

**Data root**: `data/` (subfolders `shapes/`, `results/`, `referendum/`, `meta/` — see FEATURE_SPEC.md Section 8). Treat this as read-only input.

**Build target**: new folder `election-site/` inside this folder (`Result Webpage/election-site/`). This folder (`Result Webpage/`) is self-contained and separate from the rest of the parent repository, which holds an unrelated polygon editor app — no need to touch anything outside `Result Webpage/`.

## Tech stack (proposed — adjust if you disagree, but state why before deviating)

- **Vanilla JS (ES modules), no build step** — matches the existing editor app's convention in this repo (`js/*.js` loaded directly by the browser) and keeps deployment to static hosting (Section 6: GitHub-hosted static files, no backend) trivial.
- **D3.js** for the choropleth map and bar charts. The data uses a custom local coordinate system, not real lat/lng (see any `geometry` column — plain X/Y, e.g. `POLYGON ((2883.27 1328.07, ...))`), so a real-world map library (Leaflet/Mapbox) is the wrong tool — D3 renders arbitrary polygon coordinates directly, which is what this needs.
- Plain HTML/CSS for page structure and layout.

## Phase 1 — sequential, must land before Phase 2 starts

Run these two in parallel with each other (they don't depend on each other), but **do not start Phase 2 until both are done and reviewed.**

### Agent 1a — Data Layer

Build `election-site/js/data.js` (or a small set of modules under `election-site/js/data/`): the **only** code in the project allowed to fetch/parse the raw CSV/JSON files in `data/`. Every other agent and every Phase 2 deliverable imports from this layer — never touches a raw file path directly. This is the single most important shared contract of the build; get it reviewed before Phase 2 starts.

Expose typed/documented functions covering, at minimum:
- Load and parse every file listed in FEATURE_SPEC.md Section 8 (shapes, results, referendum, meta)
- Derived status computation per precinct/seat (`Not received` / `Verifying` / `Counting` / `Declared`) against real wall-clock time (Section 2)
- Electorate-weighted `% declared` at any level (Section 2)
- Alma Vale / Home Districts / General Direct winner computation: Supplementary Vote, including the second-round transfer logic and NIL handling (Section 4)
- General Proportional's full two-stage Hare quota + largest remainder algorithm, including the 15% gate and list coalitions from `election_meta.json`'s `lists[]` (Section 4 — a worked example with expected output is in the spec; write a test against it)
- `Local Representative`'s derivation rule (aggregate Alma Vale votes by District) — Section 4
- Constituency presentation order (group by `Region`, sort by `Constituency_Code`) — Section 1
- Split-district handling for the County/District second layer (filter by District + active Constituency) — Section 1
- Neighbor/adjacency computation for the >10,000-polygon load-limiting rule (Section 1) — precompute once, don't recompute per click

Write this defensively against incomplete data — several result files are currently sparse or empty (Section 7's simulation checklist lists exactly what's missing). The data layer should handle blank/missing rows gracefully (e.g. `Not received` status, no crash), not assume everything is filled in.

### Agent 1b — Synthetic Test Data

Fill in the gaps listed in FEATURE_SPEC.md Section 7's simulation checklist (in `data/`, not the build folder) so Phase 2 agents have real data to render against:
- Populate `results/df_results_alma_vale.csv` (currently 0 of 20,850 rows)
- Fill in all `received_at`/`verified_at`/`declared_at` timestamps across every results and referendum file — stagger them realistically around the `election_date` in `election_meta.json` so the status pipeline (Not received → Verifying → Counting → Declared) is actually exercised at different points if the site is loaded at different times
- Fill in `Yes_Votes`/`No_Votes`/`Electorate`/`Turnout` for both referendum files
- Extend `results/df_results_general_proportional.csv` to properly cover all 10 sectors
- Respect every invariant already documented in Section 4 (`Turnout + Spoil ≤ Electorate`, transfer columns sum to `Turnout − Spoil`, MR doesn't participate in Home Districts, etc.) and the party lineups already fixed in `meta/df_party_participation.csv` — don't invent participation that contradicts it

## Phase 2 — parallel, after Phase 1 lands

All of these import only from the Phase 1 data layer.

- **Agent 2a — Map/Choropleth**: 3-layer drill-down (Constituency → County-or-District toggle → Precinct) for the General Election, reset button, spectrum-based coloring, status labels, neighbor-based load limiting (Section 1). A separate, structurally similar but independently-scoped Authority → County → Precinct map for the Referendum page's geographic seat types (currently only `AlmaVale` — Section 5).
- **Agent 2b — General Election results pages**: overview (seats won per party, by seat type), per-seat-type pages, individual seat detail pages, Alma Vale's round 1/round 2 bar charts (Section 4). General Direct is a **functional constituency — table only, never on the map** (Section 4); build it as a flat table, not a map layer.
- **Agent 2c — Referendum page**: the Authority/County/Precinct map for geographically-scoped seat types plus a separate flat table for General Direct's contribution (Section 5) — same functional-constituency rule as 2b.

## Phase 3 — sequential, after Phase 2 lands

**Agent 3 — Integration & QA**: wire the pages together (nav/routing), then verify against FEATURE_SPEC.md end-to-end — re-run the kind of checks documented in Section 8's "Audited" notes (schema match, referential integrity, no orphaned Constituency values, etc.) against whatever Agent 1b generated. Run the site in a browser and click through: default Constituency view → drill to County/District → drill to Precinct → reset; each seat type's results page; the referendum page. Report anything that contradicts FEATURE_SPEC.md rather than silently fixing it by guessing — flag it back the way FEATURE_SPEC.md's own open-items process did throughout its drafting.

---

## Build status: complete (2026-08-03)

All three phases landed in `election-site/`. Summary of what shipped, and what happened after the initial Phase 1–3 pass:

- **Phase 1** — `election-site/js/data.js` + 10 submodules under `js/data/`, 8 Node test suites (including an exact match against Section 4's worked Proportional example). Synthetic data generated in `data/`: all 20,850 Alma Vale precinct rows, every `received_at`/`verified_at`/`declared_at` timestamp staggered so the status pipeline is visibly mixed right now, and `df_results_general_proportional.csv` consolidated from 15 sample rows to the correct 10 sectors (with a real `Spoil`-calculation bug fixed along the way).
- **Phase 2** — `js/map/electionMap.js` + `referendumMap.js` (D3-based, load-limited per Section 1), the full General Election page set (`index.html` overview, 4 seat-type pages, seat-detail pages, `Local Representative`'s derived sub-page, round 1/2 bar charts, the Proportional allocation breakdown), and `referendum.html`. Built against a shared contract (`election-site/BUILD_NOTES.md`) so three parallel builds stayed compatible.
- **Phase 3** — nav/breadcrumbs wired across every page; a real `"undefined"` breadcrumb bug fixed; the Home Districts/General Direct collapsible rows fixed to show actual named `Sub_Constituency` data instead of an aggregate placeholder (Section 4); the referendum map's Yes/No color pair run through the `dataviz` skill's validator rather than left as a guess.
- **Post-launch fixes**, from user-reported issues after the initial build:
  - `run_site.bat` added (repo root of this folder) — starts the static server from the correct directory and opens the site, since `data/` being a sibling of `election-site/` means the server root has to be this folder, not `election-site/` itself.
  - `election-seat.html` was missing its `css/map.css` `<link>`, so the seat-detail map rendered as an empty, unstyled box — fixed.
  - The all-40-constituency national map was added to `election-alma-vale.html` (previously the map only existed locked to one constituency on a seat-detail page, which read as broken/pointless on its own) — see the "Open items" resolution in FEATURE_SPEC.md for why that page specifically.
  - **Turnout-visibility bug**: the data layer was exposing a row's `Turnout` regardless of that row's own status, so a `Verifying` precinct showed a real turnout number it shouldn't have (Section 2: turnout only becomes visible at `Counting`). Fixed at the data layer (`results.js`, `referendum.js`) to return `null` below that threshold, with every consuming page updated to render that as "—" instead of a stale/misleading number.

To run it: double-click `run_site.bat`, or serve `Result Webpage/` yourself (e.g. `python -m http.server 8080` from this folder) and open `election-site/index.html`.

# Phase 2 build notes — file ownership & shared contracts

**Status: build complete.** This started as the Phase 2 contract handed to three parallel
agents (2a map, 2b General Election pages, 2c Referendum page); it's kept here as the
authoritative record of that contract plus everything decided/fixed after. See "Post-launch
fixes" at the bottom for what changed after the initial Phase 1–3 pass landed.

Three agents (2a map, 2b General Election pages, 2c Referendum page) were building in parallel
and couldn't see each other's work-in-progress. This document was the contract that kept their
output compatible. If you're extending the site later, the file-ownership split and the map
component's API contract below are both still the live conventions to follow — don't invent a
second way of doing either.

## Already done (Phase 1, don't touch)

- `js/data.js` + `js/data/*.js` — the data layer. Import ONLY from `js/data.js`. Never fetch a
  raw `data/*` file yourself, never import from `js/data/*.js` submodules directly.
- `css/base.css` — shared reset, typography, nav bar styles, `.card`/`.status-badge`/
  `.data-table` helpers, CSS custom properties for spectrum colors (`--spectrum-left` etc.) and
  status colors (`--status-declared` etc.). Every page should `<link>` this. Add page-specific
  rules to your OWN css file, not this one.
- `js/nav.js` — exports `renderNav(container, currentHref)` and
  `renderBreadcrumbs(container, crumbs)`. Every page should call `renderNav` near the top of its
  `<body>`. Don't rebuild nav yourself.

## File ownership (so parallel writes don't collide)

- **Agent 2a (map)** owns: `js/map/*.js`, `css/map.css`, `map-demo.html` (a standalone page to
  self-test your map component in a browser without depending on 2b/2c's pages).
- **Agent 2b (General Election pages)** owns: `index.html` (this IS the General Election overview
  / home page — FEATURE_SPEC.md Section 4 calls it "main/home page"), `election-*.html` (one per
  seat type + seat detail pages, your naming choice, just be consistent), `js/pages/election-*.js`,
  `css/results.css`.
- **Agent 2c (Referendum page)** owns: `referendum.html`, `js/pages/referendum.js`,
  `css/referendum.css`.

Don't create or edit files outside your own list above except reading `js/data.js`'s exports,
`css/base.css`, and `js/nav.js`.

## Map component contract (2a implements, 2b/2c consume)

2a builds two mountable, framework-free ES module components. 2b and 2c import and use them
per this exact signature — build against it now even though 2a's implementation may land at a
slightly different time (background parallel build); Phase 3 reconciles any mismatch.

```js
// js/map/electionMap.js — General Election: Constituency -> County-or-District -> Precinct
export async function mountElectionMap(container, options)
// options: {
//   mode: 'county' | 'district',       // site-wide toggle, caller controls/persists this
//   lockToConstituency?: string,       // if set, map opens already drilled into this constituency
//                                       // and the reset button returns to THIS view, not the top
//                                       // (used for individual seat detail pages, Section 4)
//   onUnitClick?: (unit) => void,      // fired when a unit at any layer is clicked
//   resultView?: '1st' | '2nd',        // shared 1st/2nd-Pref toggle driving every tooltip's
//                                       // results table -- '2nd' always means the ACTUAL settled
//                                       // tally, never a hypothetical (added 2026-08-04, see the
//                                       // election-alma-vale.js overhaul entry below)
// }
// returns: {
//   reset(): void,                     // per Section 1's reset button
//   setMode(mode: 'county'|'district'): void,
//   setResultView(view: '1st'|'2nd'): void,
//   drillTo(level: 'constituency'|'second'|'precinct', id: string): void,
//   destroy(): void,
// }
```

```js
// js/map/referendumMap.js — Referendum: Authority -> County -> Precinct (fixed layers, no toggle)
export async function mountReferendumMap(container, options)
// options: { onUnitClick?: (unit) => void }
// returns: { reset(): void, drillTo(level: 'authority'|'county'|'precinct', id: string): void, destroy(): void }
```

**Load-limiting technique (corrected 2026-08-04 — this paragraph previously described a rule
neither map actually implements):** neither map uses `getUnitAndNeighborIds`/`getAdjacency`
neighbor loading, despite FEATURE_SPEC.md Section 1's literal wording. Both instead render every
unit at the top level always, and expand exactly one path at a time in place (NYT/AP style):
clicking a unit reveals its children while every sibling stays at its own (already-rendered)
level, and going back up collapses it again. This bounds total rendered shapes well under Section
1's >10,000 concern by construction, without ever computing geometric adjacency —
`electionMap.js` settled on this after "several rounds of geometric-adjacency bugs" (its own
module doc); `referendumMap.js` originally shipped with the neighbor-loading approach the spec
describes, then was rewritten to match `electionMap.js`'s model on 2026-08-04 (see "Post-launch
fixes" below) for the same one-render-pass simplicity — `getUnitAndNeighborIds`/`getAdjacency`
(`js/data/shapes.js`) still exist and are tested, just unused by either live map component now.
See FEATURE_SPEC.md's Open Items for the spec-level record of this divergence.

Coloring differs by design, not oversight: `electionMap.js` colors precincts by leading
**spectrum** (`--spectrum-*` from `base.css`). `referendumMap.js` has no spectrum — it colors by
leading **Yes/No** side instead, using `--ref-yes`/`--ref-no`/`--ref-progress` (`css/map.css`, not
`base.css`). Both share the same `Not received`/`Verifying`/`Counting`/`Declared` status labels
per Section 2, but `referendumMap.js` additionally collapses Verifying/Counting into one neutral
"not yet resolved" gray at the Authority/County aggregate level (a mix of many precincts' statuses
has no single meaningful color there), while a single Verifying/Counting **precinct** gets its own
flat white fill (`--ref-progress`) rather than sharing Not received's gray.

**Reminder for everyone**: General Direct never appears on any map (General Election or
Referendum) — it's a functional constituency, table-only (Section 4/5). Don't wire it into
either map component.

## Charts (2b, and 2c if needed)

Bar charts (Alma Vale round 1/round 2, Proportional party/list bars) are 2b's responsibility.
D3 is the proposed tool (already assumed available as a script include — add your own `<script>`
tag pulling it from a CDN, or vendor a copy under `js/vendor/` if you prefer no network
dependency at build time; state which you chose). **Load the `dataviz` skill before writing any
chart code** — it has the house style for colors, form, and layout this build should follow.
Use shades of each party's parent spectrum color for party-level bars (Section 3).

## Serving the site for testing

`js/data.js` uses `fetch()`, which is blocked under a bare `file://` origin. `data/` lives as a
*sibling* of `election-site/` (both under `Result Webpage/`), not inside it, and `config.js`
resolves the data root via `import.meta.url` math that expects exactly that layout — so the
static server's root must be `Result Webpage/` itself, not `election-site/` (serving from
`election-site/` makes browsers unable to reach `data/` at all, since it's outside the served
root — no relative-path fix changes that). Run the server from `Result Webpage/`, e.g.
`python -m http.server 8080` or `npx serve`, then open
`http://localhost:PORT/election-site/index.html` (or your test page under `election-site/`).

## Open items from Phase 1 worth knowing about

- ~~`GeneralProportional`'s vote column `Right` is a literal party-column name...~~ **Fixed
  2026-08-04, see "Post-launch fixes" below** — the CSV column and `election_meta.json` were
  renamed to the real `GCCA` party instead of living with the mismatch. `Right_*` transfer-column
  naming in the SupplementaryVote files is unrelated and unaffected.
- Region presentation order (Capital, Highland, Lowland) is implemented alphabetically in the
  data layer (`groupConstituenciesByRegion`) since FEATURE_SPEC.md never states an explicit
  order beyond one example — use whatever order `groupConstituenciesByRegion`/`orderConstituencies`
  return rather than hardcoding your own.

(FEATURE_SPEC.md's own "Open items" section now also records these, plus a few more resolved
during Phase 3/post-launch — that's the canonical list if the two ever drift.)

## Post-launch fixes (after the initial Phase 1–3 pass)

Issues reported after the site was first considered done, fixed directly rather than
re-running a full agent phase for each:

- **`run_site.bat`** added at the `Result Webpage/` root — starts a static server rooted there
  (required, see "Serving the site for testing" above) and opens the site in the default
  browser. Closing the console window it spawns stops the server.
- **`election-seat.html` was missing `<link rel="stylesheet" href="css/map.css">`** — it mounts
  `mountElectionMap` but never linked the map's own stylesheet, so the seat-detail map rendered
  as an empty, unstyled grey box (no sizing rules on `.map-svg`, unstyled legend/toolbar). Fixed
  by adding the missing `<link>`. Cross-checked every other `.html` file for the same gap (only
  pages that actually mount a map component need this link — `map-demo.html`, `referendum.html`,
  and now `election-seat.html`).
- **National (unlocked, all-40) Constituency map added to `election-alma-vale.html`.** Originally
  the only place `mountElectionMap` was used was the seat-detail page, locked to one
  constituency — which read as broken/pointless in isolation, since Section 1's drill-down model
  (Constituency → County/District → Precinct, starting from all 40) never had anywhere to
  actually live. Added it, unlocked, above the seat table on the Alma Vale seat-type page (see
  FEATURE_SPEC.md's Open Items for why that page specifically). Extracted the toggle-button and
  defensive-mount logic that already existed on the seat-detail page into shared helpers
  (`mapToggleControls`, `mountElectionMapDefensively` in `js/pages/election-common.js`) so both
  pages use one `localStorage`-backed shared mode instead of two independent copies of the same
  code — this is also what makes the County/District toggle genuinely site-wide (Section 1)
  rather than page-local.
- **Turnout-visibility bug, data layer.** `js/data/results.js` and `js/data/referendum.js` were
  exposing a row's raw `Turnout` value regardless of that row's own status — so e.g. a
  `Verifying` precinct (received, not yet verified) showed a real turnout number in the UI, which
  contradicts Section 2's table (`Turnout` only becomes visible at `Counting`). Root cause was a
  literal reading gap in `results.js`'s own status-gating doc comment, which correctly gated vote
  totals to Declared-only but never applied the equivalent Counting-only gate to Turnout. Fixed
  by gating every single-row Turnout exposure (`turnoutIfKnown`/`sumKnownTurnout` in
  `results.js`, the equivalent inline gate in `referendum.js`'s `summarizeYesNo`) to return
  `null` below Counting instead of the raw CSV number — `null` rather than `0`, so the UI can
  tell "not yet counted" apart from a genuine zero-turnout row. Every page that renders a
  turnout figure was updated to show `null` as "—" (`formatTurnout`/`fmtTurnout` helpers) rather
  than a stale or misleading number. Verified directly against live data post-fix: zero
  `Not received`/`Verifying` rows have a non-null turnout, and zero `Counting`/`Declared` rows
  have a null one.
- **`election-home-districts.html` rebuilt with its own dedicated table** instead of the shared
  `renderConstituencySeatRows()` (`js/pages/election-common.js`) — General Direct later got the
  same treatment too, see further down. Home Districts never fields an MR candidate (`df_party_participation.csv`: `MR_Participate` is
  `no` on every Home Districts row — Section 3), so a plain two-party vote breakdown is meaningful
  here in a way it isn't for Alma Vale/General Direct. Columns, in order: Constituency, Electorate,
  Turnout, Turnout (%), Left Vote, Right Vote, Spoil Vote, L Pct, R Pct, Results. "Results" merges
  the old separate Status/Result columns into one cell — status badge while the seat is still
  reporting, winning party once every underlying row is Declared (never a "Leading: X" guess).
  Constituency names are plain text now, not links to `election-seat.html` — this page no longer
  routes to the per-seat detail sub-page. A bold **Total** row sums Electorate/Turnout/Left
  Vote/Right Vote/Spoil Vote across all 5 seats and recomputes Turnout %/L Pct/R Pct from those
  sums; its Results cell is intentionally blank ("—") since there's no single winner across 5
  separate seats. The Sub_Constituency expand rows (e.g. `Tong`) got the same column set and lost
  the old "This seat's total aggregates N Sub_Constituency reporting rows" explanatory line.
  Added `turnout` (Counting-gated `sumKnownTurnout`, same convention `buildSubRowSummaries`
  already used) to `buildSupplementaryVoteSeatSummary()`'s return shape in `js/data/results.js` —
  previously only sub-rows carried a `turnout` field, top-level seats didn't. Purely additive, all
  other seat types/pages unaffected (confirmed via the full data-layer test suite).
  All-column centering (`css/results.css`'s `.hd-table` rules, scoped so General Direct's shared
  `.seat-table` styling is untouched) hit a real CSS-specificity gotcha worth remembering: a bare
  `.hd-table th, .hd-table td { text-align: center }` (1 class + 1 type = lower specificity) loses
  silently to `base.css`'s `table.data-table th, table.data-table td { text-align: left }` (1 class
  + 2 types = higher) — needs the `table.data-table.hd-table th/td` qualifier to actually win. The
  Constituency/Sub_Constituency name column is the one exception: header centered, but the name
  itself (`td:first-child`) stays left-aligned — long names plus the expand-toggle icon read
  better ranged left than centered.
- **General Proportional's `Right` party-column quirk fixed at the data layer, and the results
  page reworked, 2026-08-04.** `df_results_general_proportional.csv`'s `Right` header column is
  now `GCCA`, and `election_meta.json`'s `GeneralProportional.lists[]` reads
  `{ "id": "Right", "parties": ["GCCA"] }` — the Right list's party is the real `GCCA` entry in
  `parties[]` now, no more literal-abbreviation special case (see the "Open items" note above,
  and FEATURE_SPEC.md's Open Items for the full writeup). `js/pages/election-general-proportional.js`
  was also reworked: the D3 Stage 1/Stage 2 bar charts are gone, replaced by a combined "Seats by
  list" table (multi-party lists expand to show their within-list party split) and a reporting-
  sectors table (one row per sector, one column per contesting party, Turnout %/Spoil/per-list
  vote-share % columns, expandable into `Sub_Constituency` sub-rows when a sector genuinely has
  more than one reporting row — grouped the same way Home Districts/General Direct already group
  sub-rows). `js/data/results.js`'s `getGeneralProportionalResult()` sectors are now grouped by
  `Constituency` (was one entry per raw row) and carry `statusSummary` instead of a bare `status`
  string. That shape change broke `election-overview.js` in two ways worth remembering if you touch
  either file again: (1) its "is General Proportional fully declared" check read a `sector.status`
  field that no longer exists (silently always `false`) — always use `isFullyDeclared(sector.statusSummary)`,
  never a raw status-string comparison, on anything coming out of that function; (2) its per-party
  seat tally only ever looped `electionMeta.parties[]`, so any list-party abbreviation without its
  own `parties[]` entry (which `Right` was, before this fix) silently vanished from every
  party-keyed view (spectrum totals, the seats bar, the breakdown table) even though the seat-type
  total still counted it — `buildDisplayParties()` in `election-overview.js` covers this generically
  now (kept as a defensive fallback even though the `GCCA` fix means it's currently a no-op for
  General Proportional specifically). New CSS: `.sector-table` and `.list-result-table` in
  `css/results.css`, scoped like `.hd-table` above (header + data cells centered except the leading
  name column; `.list-result-table` also caps table width instead of stretching full-width, since
  it's only 4-5 columns).
- **`election-general-direct.html` rebuilt with its own dedicated table too, 2026-08-04** (same
  motivation as the Home Districts rebuild above — it no longer uses the shared
  `renderConstituencySeatRows()` either). Columns, in order: Constituency, Electorate, Vote,
  Turnout %, Left/MR/Right Final, Left/MR/Right 1st, Spoil, Status (merged Status/Result, same
  convention as Home Districts' Results column). "Final" replaces the original "2nd" label and
  always holds the seat's settled per-spectrum number — `round2`'s value when a 2nd round actually
  ran, otherwise a copy of `round1` (a spectrum that wins outright in round 1 never shows a
  fabricated zero in Final) — and only Final ever gets the winner's bold treatment, never 1st.
  `0` replaces `—` for every vote cell that's genuinely zero/not-applicable (an eliminated
  spectrum's Final, `Local Representative`'s columns — see below); `—` is reserved for
  actually-unknown values (Turnout % with no denominator, a real seat's Vote before Counting).
  `statusCell`/`resultCell` in `js/pages/election-common.js` got exported (previously
  module-private) so this page's merged Status/Result cell could reuse them alongside its own
  custom columns. New CSS: `.gd-vote-table` in `css/results.css` (header + data centered except
  the leading Constituency column, same `:first-child` pattern as `.hd-table`/`.sector-table`),
  `.vote-cell--winner` (bold), and `.scroll-table-wrap--full-height` (drops the `max-height`/
  inner-scrollbar that `.scroll-table-wrap` normally has, so this one table reads top-to-bottom
  on the page instead of scrolling internally — other tables sharing `.scroll-table-wrap`
  unaffected). Constituency names are plain text, no longer linking to `election-seat.html`,
  except `Local Representative` which still links to its own sub-page.
- **`Local Representative` given real Electorate/Vote/Turnout/per-spectrum numbers instead of
  placeholder blanks, 2026-08-04.** `js/data/localRepresentative.js`'s
  `deriveLocalRepresentative()` now also returns `totalDistrictsNationwide` (sum of every
  council's `totalDistricts`). `js/data/results.js`'s `getLocalRepresentativeSeat()` uses it to
  synthesize `electorate`/`turnout` (both = that total, so Turnout % comes out to exactly 100%)
  and a `round1` keyed by spectrum (districts won by that spectrum's pooled display party, via
  the existing `buildSpectrumDisplayLabels`) — `round2` stays `null` and `totals.Spoil` stays `0`
  (FPTP derivation, no Supplementary Vote transfer round applies). This only feeds the General
  Direct list page's shared vote table; the real per-District Declared/undeclared split is still
  only on `election-local-representative.html`, unaffected by this change. Also dropped that
  page's descriptive subtitle and FEATURE_SPEC.md-quoting derivation-rule banner (stat tiles and
  data tables kept, prose trimmed — same instinct as the "This seat's total aggregates..." caption
  removal in the Home Districts rebuild above).
- **`Local Representative`'s derivation corrected, 2026-08-04** — four user-directed fixes after
  reviewing live output against the shapefile data; see FEATURE_SPEC.md's Open Items for the
  spec-level "why" on each, this entry is the implementation side:
  - `js/data/shapes.js`'s `getFragmentAssignments()` rewritten from a point-in-polygon spatial
    join to a plain `(District, District_Ward)` label match — `df_districts.csv` was regenerated
    with its own `District_Ward` column that matches `df_polygon.csv`'s exactly (0 misses, 0
    duplicate keys across all 20,850 precincts), so the spatial workaround (and its
    `parseCentroidPoint`/`pointInRing`/`pointInPolygonRings` helpers, all removed) is no longer
    needed.
  - `js/data/localRepresentative.js`'s `deriveLocalRepresentative()` reworked: buckets precincts
    by `(District, District_Ward)` — 1,779 units — instead of by District *name* (~37); a bucket
    only contributes votes/a winner once **every** one of its precincts is Declared, not just one
    (previously a unit with e.g. 4 of 5 precincts Declared was already being counted, which could
    misattribute a plurality that the 5th precinct's votes would have flipped); and the tally
    works spectrum-first (`tallyFirstPreferenceSpectrumVotes`, no per-precinct party lookup
    needed) with the display label applied only at the end (`buildSpectrumDisplayLabels`,
    `relabelSpectrumVotes`) — this is what pools NRD- and LRP-sourced Left votes under one `LRP`
    label, replacing the old per-constituency `buildPartyByConstituencySpectrum`/
    `tallyFirstPreferencePartyVotes` pair (removed). Also added `buildCouncilTotals()` and
    `buildCouncilRegions()` (a council's `Region` is consistent across every precinct that
    belongs to it — verified, unlike `Constituency`, which 12 District names genuinely straddle)
    feeding a new `councils` object on the derivation result: per-council `region`,
    `totalDistricts`, `declaredDistricts`, `undeclaredDistricts`, `seatsByParty`, `votesByParty`.
  - `js/map/electionMap.js`'s District-mode FPTP tally (fill color + "D" tooltip tick) reverted
    to per-fragment scope (matching the 1,779-unit correction above) after briefly being changed
    to whole-District-name scope during the investigation — District mode's tier-2 unit already
    *is* one `(District, District_Ward)` fragment, so no aggregation across fragments is needed
    once "District" means what the fragment already represents.
  - `election-local-representative.js`'s "Vote breakdown by party, per District" table (previously
    1,700+ rows, one per District unit) replaced with `councilBreakdownTable()`: one row per
    council (Total districts / per-party seats / per-party votes / Undeclared columns), grouped
    into collapsible Region sections (Capital/Highland/Lowland, alphabetical — same
    `expand-toggle` interaction as the General Direct/Home Districts sub-row pattern, just
    toggling several rows sharing a `data-region-group` attribute instead of one sub-table). Each
    region header shows a `regionSpectrumSeats()` rollup on its own line below the name: `Total
    Seats`/`Left Seats`/`Middle Right Seats`/`Right Seats` (summed `seatsByParty`, mapped back to
    spectrum via `Data.findParty` rather than hardcoded) plus `Undecided` (summed
    `undeclaredDistricts`). The header's own result indicator (`resultHeaderNode()`) was
    simplified to never show a party pill in a not-final state — just plain "Undecided" / "No
    result yet" text, no leading-party color, since a partial lead isn't a result.
  - **CSS specificity bug, same category already logged for `.hd-table`/`table.data-table` and
    `.ref-drill-table` above**: `.district-table td, .district-table th { text-align: right }`
    (1 class + 1 type) was silently losing to `base.css`'s `table.data-table th, table.data-table
    td { text-align: left }` (1 class + 2 types) — every numeric column in both District-derived
    tables (`districtsWonTable`, `councilBreakdownTable`) was rendering left-aligned regardless of
    this rule. Fixed by qualifying as `table.data-table.district-table`, and changed `right` to
    `center` per request (first column stays left via `:first-child`). Also added
    `scroll-table-wrap--full-height` to `councilBreakdownTable`'s wrapper — same modifier already
    used by General Direct's table — so the (now much shorter, region-collapsed) table reads
    top-to-bottom instead of scrolling in a fixed-height box.
- **Referendum page overhaul, 2026-08-04** (`referendum.html`, `js/pages/referendum.js`,
  `js/map/referendumMap.js`, `css/map.css`, `css/referendum.css` — crosses the original 2a/2c
  ownership split, fine post-launch). Driven by a long round of user feedback; grouped by area:

  - **AlmaVale/GeneralDirect results no longer summed.** The old "Overall result" section
    combined both scoped seat types' Yes/No totals into one bar — wrong, since they're different
    electorates voting on the same question, not one pool. Replaced with `renderSectionSummaries()`
    /`sectionSummaryCard()`: one card per scoped seat type (`.ref-summary__grid`), each with its
    own bar, valid votes/turnout/electorate, and a large `Status: In Progress` /
    `Status: Agree` / `Status: Disagree` line (`referendumStatusLabel()`) — "decided" means the
    current Yes/No margin exceeds the maximum vote pool that could still land (the
    not-yet-Declared share of that section's electorate, i.e. `electorate × (1 − percentDeclared /
    100)` — the same pool `percentDeclared` itself is computed from, not raw turnout, so a fully
    Declared section reads as decided even though `electorate > turnout`). GeneralDirect's own
    multiple seats are still summed together for its one card (`aggregateGeneralDirect()`) — a
    legitimate within-seat-type aggregate, unlike the removed cross-seat-type sum.
  - **`referendumMap.js` rewritten to `electionMap.js`'s render model** (see the corrected Map
    component contract section above) — dropped the old neighbor-loading Authority/County layers
    (`getUnitAndNeighborIds`, dimmed/dashed "context" shapes) for the same always-render-everything,
    one-path-expanded single `renderAll()` pass `electionMap.js` already used. Incidental fix: the
    old `drillTo(level, id)` internally re-entered and fired its own `onUnitClick` as a side
    effect, which `referendum.js`'s `selectUnit()` had to work around with a render-sequence guard
    and a "re-assert this call's own intent" state patch after every `map.drillTo()` call (see the
    git history for the removed comment block). The new `drillTo` sets state directly and never
    fires `onUnitClick` itself — only a genuine shape click does — so that workaround was deleted
    outright, not just papered over.
  - **Map tooltips rewritten to a real results table**, all three layers (Authority/County/
    Precinct): an Option/Votes/Pct table (`referendumOptionsTableHtml()` — Yes/No sorted
    winner-first, like `resultsTable.js`'s party table) plus the shared Turnout/Status/% of votes
    in trio, reusing `aggregateStatusLabel()`/`statusLinesHtml()` straight from
    `js/map/resultsTable.js` (those two were already generic, not election-specific — no
    duplication needed). Real bug caught and fixed in the process: the precinct-level tooltip was
    passing `info.yes`/`info.no` into the table unconditionally — those are the raw CSV cell
    values regardless of status (nothing blanks them pre-Declared), so a Verifying/Counting
    precinct was showing a "final" vote split it shouldn't have, violating Section 2's Declared
    gate that every other vote-total display on the site already respects. Fixed by only passing
    real numbers through when `status === 'Declared'`.
  - **Legend/coloring simplified**: legend trimmed to just "Yes leading"/"No leading" (dropped
    Not received/Verifying/Counting entries); map fill for those three pre-Declared statuses
    collapsed to one neutral gray at the aggregate level via `neutralColorVar()`, EXCEPT a single
    Verifying/Counting **precinct**, which gets a dedicated flat white fill (`--ref-progress:
    #ffffff`, new in `css/map.css`) so it still reads clearly against both the gray and the Yes/No
    colors. `--ref-no` changed from purple (`#7c3aed`) to red (`#d1382e`) — propagates everywhere
    that reads the variable (bars, choropleth, lean indicators) from one edit.
  - **Drill tables (Authority/County/Precinct side-panel tables + the General Direct flat table
    + its Sub_Constituency breakdown) redesigned** to a shared `Name | Yes | No | Lean | Status`
    shape (`renderDrillTable()`/`renderStatusCell()`/`renderLeanBar()` in `referendum.js`; the
    Authority/County pair was factored into one `renderDrillTable()` call, replacing two
    near-duplicate implementations). Yes/No are exact vote counts (`fmtInt`); Lean is a compact
    percentage-labeled two-color bar (`.ref-lean-bar`), not a dot+text; Status shows the green
    "Declared" badge (`statusBadge`) once `percentDeclared` hits 100, otherwise `"{pct}% in"`
    (renamed from `"{pct}% declared"` everywhere that exact phrasing appeared, to read less
    redundant next to the badge). Trimmed accompanying prose throughout: the "Referendum"
    breadcrumb crumb, the map's under-map status-line sentences ("36 authorities", "N counties in
    X — other authorities stay at authority level", etc. — `updateBreadcrumbAndStatus` →
    `updateBreadcrumb`, breadcrumb trail itself kept), the Alma Vale/General Direct section
    subtitles, the "(N reporting areas)" row annotation, the "Rows with multiple reporting
    areas..." footnote, and the precinct-detail panel's Electorate/Turnout line (now shows nothing
    when not yet Declared, just `"100% declared"` when it is — no redundant status badge there
    either, the bar + text already say it). "General Direct — Functional Constituency" heading
    shortened to "General (Individual Sector)".
  - **CSS specificity bug, worth remembering** (same category as the `.hd-table`/`table.data-table`
    gotcha already logged above for Home Districts): `.ref-drill-table { width: auto }` (one class,
    specificity 0-1-0) was silently losing to `base.css`'s `table.data-table { width: 100% }`
    (element+class, 0-1-1) — element+class always beats a plain class regardless of which
    stylesheet loads later, so the "make the table narrower" request appeared to do nothing across
    several iterations until this was traced. Fixed by qualifying the selector as
    `table.ref-drill-table` to match specificity, which then correctly wins via source order
    (`referendum.css` loads after `base.css`). Column-width tuning after the fix: Name/Yes/No use
    the `width: 1%` shrink-to-content trick; Lean gets a guaranteed `min-width` so its bar's
    percentage labels don't get squeezed/overlapping; Yes/No run smaller and tighter in the narrow
    Authority/County/Precinct side panel (`.ref-precinct-list .ref-drill-table ...`) than in the
    full-width General Direct table (`#referendum-functional-table .ref-drill-table ...`), which
    keeps a larger, roomier Yes/No presentation since it isn't width-constrained the same way.
- **General Proportional's `Local Representative` sector populated from Alma Vale data, and its
  Quota tile reworked into a Quorum tile with a tighter gate, 2026-08-04** — both user-directed,
  see FEATURE_SPEC.md's Open Items for the spec-level "why" on each, this entry is the
  implementation side:
  - `js/data/localRepresentative.js`'s `deriveLocalRepresentative()` gained an optional
    `partiesForRow` input: when passed, each District's plurality winner is decided via the new
    `tallyFirstPreferencePartyVotes(rows, partiesForRow)` (keeps NRD/LRP separate, resolved
    per-row) instead of the default `tallyFirstPreferenceSpectrumVotes` +
    `relabelSpectrumVotes(spectrumVotes, spectrumDisplayLabels)` pooled-label path — everything
    downstream of that one `labelVotes` map (district winners, `districtsWonByParty`,
    `councilSeats`/`councilVotes`, `marginSafeResult`) is unchanged and agnostic to which path
    produced it. Both tally functions now share a `round1BySpectrum(row)` helper (previously
    duplicated inline in `tallyFirstPreferenceSpectrumVotes`).
  - `js/data/results.js`'s new `buildLocalRepresentativeProportionalSector()` calls
    `deriveLocalRepresentative()` with a `partiesForRow` resolver built from `AlmaVale`
    participation rows (Constituency → Left/MR/Right party abbreviation, joined per precinct via
    `shapeIndex.polygonById`), then shapes the result into the same sector shape the other 9
    reporting sectors use: `electorate`/`turnout` both pinned to `derived.totalDistrictsNationwide`,
    `spoil` always 0, `partyVotes` = `derived.districtsWonByParty` keyed by the actual NRD/LRP/GRF/
    GCCA abbreviations (`null` while zero Districts are yet fully Declared, same "nothing to show
    yet" convention `sumSectorPartyVotes` uses for the other sectors), `subRowCount` pinned to 1
    (no per-District/per-precinct expand — that granularity already exists on the Alma Vale /
    Local Representative sub-pages), and a synthesized `statusSummary` (new helper
    `districtStatusSummary()`) built from `derived.districtsConsidered`/`totalDistrictsNationwide`
    rather than re-running `summarizeStatus()` over ~20,850 individual precinct rows.
    `getGeneralProportionalResult()` now filters `Local Representative`'s always-blank CSV row out
    of its normal per-row tally (`rows = allRows.filter(...)`) and folds this derived sector's
    numbers into the national `electorate`/`partyVotes`/`spoil`/`isFinal` accumulators instead,
    while still iterating `allRows` (not the filtered set) when building the `sectors` array so
    `Local Representative` keeps its original position among the 10 (test asserts
    `sectors.length === 10`, unaffected). New helper `isFullyDeclaredSummary()` (data-layer
    equivalent of `election-common.js`'s page-layer `isFullyDeclared()`, duplicated rather than
    imported across the data/pages boundary) gates whether the derived sector counts toward
    `isFinal`.
  - The Quorum figure was first wired to `result.gateVotes` directly, then it emerged that figure
    silently meant two different things depending on `isFinal` (`15% × Electorate` while
    provisional, `15% × Valid Votes` once final) — so the tile's number and the `Qualified`
    column's actual gate could visibly disagree mid-count (e.g. a list clearing 15% of votes
    counted so far still showing "below gate"). Resolved by tightening the provisional gate
    itself rather than just the display: `js/data/proportional.js`'s
    `computeGuaranteedMinimumAllocation()` gained an optional `voteBound` input (gate/quota now
    computed against it, `electorate` kept only for the Turnout display figure; falls back to
    `electorate` when omitted, so every existing caller/test is unaffected), fed by
    `results.js`'s new `computeSafeVoteBound()` — sums, per reporting row, whichever of
    Electorate/Turnout/actual-Valid-Votes is currently the tightest value guaranteed not to
    understate that row's eventual contribution (Not received/Verifying → `Electorate`; Counting →
    `Turnout`, since `Valid = Turnout − Spoil ≤ Turnout`; Declared → its exact Valid Votes, no
    substitute needed), plus the derived `Local Representative` sector's own bound (always exactly
    `totalDistrictsNationwide`, since a District's Electorate and eventual vote are both exactly
    1 either way). The Quorum tile now simply reads `result.gateVotes` (`Math.round`, not
    `Math.ceil`) — same figure the `Qualified` column's gate check itself uses, in both allocation
    methods, so the two can't drift apart again. Verified against the "never overstates"/
    monotonicity tests in `test/proportional.test.mjs` (both still pass unmodified, since they
    never pass `voteBound` and so exercise the `electorate`-fallback path) plus a manual check
    that `voteBound`'s national total, worked by hand from the live 9/10-declared data, matches
    the rendered Quorum figure exactly.
- **`index.html` overview page reworked, 2026-08-04** (`js/pages/election-overview.js`,
  `css/results.css` — user-directed, no data-layer changes):
  - **Seats-won bar (`renderSeatsBar`) now emits one segment per spectrum, not one per party.**
    Previously each party inside a spectrum got its own adjacent same-colored segment/label (e.g.
    Left showing "21" then "19" side by side instead of one "40"), which visually undercounted a
    spectrum with a pseudo-party (General Proportional's `Right` list-party) whose own segment was
    often too narrow to carry a label. Segments are now built by summing every party in a spectrum
    first; the per-party breakdown moved into the segment's hover `title` instead of separate
    visible sub-segments.
  - **Party tally table gained three trailing columns: Left / MR / Right**, each a vote-share
    percentage (`votes / (Left+MR+Right votes)`) for that row's own seat type — Alma Vale/Home
    Districts/General Direct sum their seats' `round1.Left/MR/Right`, General Proportional reads
    `list.votes` directly (list ids already equal spectrum ids). Both these columns and the
    existing per-party columns are now header-and-data centered except the leading Seat type
    column (same `:first-child`-exception pattern as `.hd-table`/`.sector-table`/`.district-table`
    above) — no new CSS class needed, `.party-tally-table`'s existing `td, th` rule was just
    changed from `text-align: right` to `center`.
  - **Alma Vale / General Proportional vote-share bar charts removed** (the `voteShareBar()`
    function and its per-bar seat-count computations) — the Left/MR/Right vote-share numbers they
    showed are now covered by the table columns above instead. The underlying spectrum-vote-total
    variables (`almaValeSpectrumVotes` etc.) were kept since the table still needs them; only the
    seat-count-only variables and the chart-rendering calls were deleted. (Alma Vale's own
    dedicated vote-share bar on `election-alma-vale.html`, a separate `.vote-share-bar` consumer in
    `js/pages/election-alma-vale.js`, is untouched — that CSS is still live.)
  - **New "Referendum Result" section**, rendered only when `data/referendum/referendum_meta.json`
    exists for the current cycle (`Data.loadReferendumMeta()` 404 → section renders nothing, not an
    error). One line per referendum seat type (`AlmaVale`/`GeneralDirect`, same restriction
    `referendum.js`'s own page has), reusing `Data.getAlmaValeReferendumResults()` /
    `Data.getGeneralDirectReferendumResults()` — General Direct's per-Constituency summaries are
    summed into one national total (`aggregateYesNo()`) the same way `referendum.js`'s own
    `aggregateGeneralDirect()` does. Format: `Results in {seat type} - {Yes|No} {pct}%`, the
    leading side's Yes/No word bold and colored via `--ref-yes`/`--ref-no` (redefined locally in
    `results.css` since `index.html` doesn't link `map.css`/`referendum.css`, where those custom
    properties normally live — kept the same hex values for consistency with the map/referendum
    page's encoding). The question line is a plain-text link to `referendum.html`. Deliberately
    **not** wrapped in `.card` (no bordered/surface background) and **not** a grid — stacked
    full-width lines, since Alma Vale and General Direct are different electorates voting on the
    same question, not comparable side-by-side columns.
  - **Spectrum summary row (`spectrumSummaryRow`) styling**: the big per-spectrum number
    (`.spectrum-summary__value`) is 1.5× larger (1.8rem → 2.7rem); its container
    (`.spectrum-summary`, fixed-height since items are absolutely positioned inside it) grew from
    3.4rem → 4.9rem to fit without clipping. The label below it (`.spectrum-summary__label`, e.g.
    "Left"/"Middle Right"/"Right") is 1.2× larger (0.85rem → 1.02rem), bold, and now colored to
    match its spectrum (previously flat `--color-muted` gray) — the color is set inline per-item in
    JS (`spectrumColor(spectrum.id)`), same as the number above it already was, since it varies per
    spectrum rather than being a single CSS rule.
- **Supplementary Vote declaration-certainty rework, 2026-08-04** (user-directed; see
  FEATURE_SPEC.md's Section 4 and Open Items for the spec-level rule and the math correction made
  along the way — this entry is the implementation side, across every file it touched):
  - `js/data/supplementaryVote.js`'s new `resolveSupplementaryVoteCertainty(svResult, undecided)`
    is the core algorithm (three margin-vs-undecided checks — round-1 majority, runoff-unavoidable,
    which-two-spectrums-make-the-runoff — then a second majority check on the round-2 tally once
    the pair is locked in). Returns `{ stage, resultCertain, winner, runoffCertain,
    participantsCertain, participants, eliminated }`. Unit-tested including the counterexample that
    disproves the naive "gap(1st,2nd) > undecided" rule (FEATURE_SPEC.md Open Items).
  - `js/data/results.js`'s new `computeUndecidedVotes(rows, now)` measures the pool that function
    is worst-cased against: per not-yet-Declared row, `Electorate` if Not received/Verifying
    (turnout itself unknown), `Turnout` if Counting (ballot count known, not yet allocated). Wired
    into `buildSupplementaryVoteSeatSummary()`, `buildSubRowSummaries()`, and
    `getAlmaValeSupplementaryVoteForShapeIds()` (the map's County/District aggregate, which needs
    its own certainty computed from its own subset's undecided pool, independent of the parent
    Constituency's) — every seat/sub-row/map-unit summary now carries a `certainty` field alongside
    the pre-existing (always-present, "currently leading") `winnerSpectrum`/`winnerParty`.
  - `js/pages/election-common.js`'s new `isResultCertain(seat)` (`seat.certainty?.resultCertain`)
    replaces `isFullyDeclared()` as the winner-display gate everywhere a Supplementary Vote seat's
    result is shown — `election-alma-vale.js`, `election-general-direct.js`,
    `election-home-districts.js`, `election-seat.js`, and `election-overview.js`'s headline
    seats-won tally. `isFullyDeclared()` itself is untouched and still used for General
    Proportional (a different method) and the derived `Local Representative` seat (its own
    pre-existing margin-safe rule in `localRepresentative.js`, unrelated to this change).
  - The Alma Vale/General Direct list tables' "Final" vote columns (`appendVoteCells` in both
    pages) now read **"Undecided"** instead of a possibly-premature round-2 number (or a
    round1-copy that might not even be the settled majority) until `certainty.stage ===
    'round1-majority'` or `certainty.participantsCertain` is true — new `.vote-cell--undecided`
    CSS (`css/results.css`).
- **Map tooltip consistency pass, 2026-08-04** (`js/map/resultsTable.js`, `js/map/electionMap.js`,
  `css/map.css` — direct follow-on to the certainty rework above, user-directed after noticing the
  map tooltip still showed round-2 numbers a list table right next to it was calling "Undecided"):
  - `resultsTableHtml()` gained a `roundTwoCertain` boolean param (default `true`, for callers with
    nothing left to be uncertain about — a single already-Declared precinct has 0 undecided
    ballots). When `false`, the 2nd Vote/Pct columns (party rows + the Spoil/NIL row) read
    **"Pending"** — the tooltip's own wording for the same underlying gate the list tables call
    "Undecided" — instead of either real round-2 numbers or the old "no round2 needed" em-dash
    (which would have wrongly implied an outright majority was already settled). New
    `.map-tooltip__cell--pending` CSS class on the affected cells.
  - `confirmedWinnerSpectrum` (the tooltip's "C" tick, all three levels) switched from a literal
    `percentDeclared >= 100` check to `certainty.resultCertain` — same certainty gate the list
    tables use. The District-mode "D" tick is untouched (FPTP-plurality-of-Districts, a different
    method, no undecided-ballot runoff math applies).
  - New `roundStatusLabel(certainty)`/`winnerStatusLabel(certainty)` in `resultsTable.js`, and
    `statusLinesHtml()` gained an optional `certainty` param: when the aggregate status is exactly
    "In progress" and a certainty object is given, the Status line grows to `"In progress, {Round
    Status}, {Winner Decided}"` — Round Status one of "No Runoff Needed" (`stage ===
    'round1-majority'`) / "Runoff Uncertain" (`!runoffCertain`) / "Runoff Needed" (`runoffCertain
    && !participantsCertain`) / "Runoff In Progress" (`runoffCertain && participantsCertain`);
    Winner Decided one of "Winner Undecided"/"Winner Decided" straight off `resultCertain`. Wired
    for the Constituency and County/District tooltips only (`electionMap.js`) — the Precinct
    tooltip never shows "In progress" (a single row's status is always one of the four literal
    values, see `aggregateStatusLabel`'s doc comment), so it omits the param and stays unchanged.
  - **Real bug fixed along the way**: the Precinct-level tooltip's own round-2 figures were shown
    unconditionally whenever that one precinct was Declared, on the reasoning that a single fully-
    Declared row has 0 undecided ballots left in it and is therefore trivially certain — true in
    isolation, but that row's own `computeSupplementaryVote()` call eliminates whichever spectrum
    is locally lowest **within that one precinct**, which is not necessarily the same spectrum the
    Constituency-wide runoff is actually eliminating. `tooltipForPrecinct()`'s `roundTwoCertain`
    now also requires the parent Constituency's `certainty.participantsCertain` AND that this
    precinct's own `eliminated` spectrum matches the Constituency's confirmed
    `certainty.eliminated` — otherwise it reads "Pending" too, same as the aggregate levels, rather
    than silently showing a locally-correct-but-globally-mismatched pairing.
- **Alma Vale "Full results by constituency" table: region subtotals, sticky name column, and
  column-visibility tickboxes, 2026-08-04** (`js/pages/election-alma-vale.js`, `css/results.css`
  — all user-directed):
  - Rows are grouped by `seat.region` (`groupSeatsByRegion()`, consecutive runs — seats already
    arrive in that order from `Data.getAlmaValeSeats()`); each region's header row
    (`regionSubtotalRow()`) doubles as an Electorate/Vote/Turnout/Final/1st/Spoil **subtotal**
    across its own seats (`sumSeatFigures()`, shared arithmetic) — Status is left blank, since
    summing per-seat statuses/winners has no single meaningful value. Final/1st sums use each
    seat's own current round1/round2 tally regardless of that seat's individual `certainty` (same
    "running total, not a per-seat declaration" convention as the 1st column and Home Districts'
    own Total row) — so a region subtotal is never itself gated behind "Undecided".
  - Each region row is expand/collapse**able**, default expanded: the **entire row** is the click
    target (`tr.dataset.clickable = 'true'`, one listener on the `<tr>`, not the toggle glyph
    alone) — the small `▾`/`▸` `.expand-toggle` button has no border/background and is easy to miss
    as clickable on its own, especially with no visible hover state in a screenshot; matches the
    `[data-clickable]` row pattern the page's own drill-down list tables already use. New CSS:
    `.seat-table__region-row[data-clickable]` (cursor:pointer) `:hover td` (highlight), with a
    specific override for `td:first-child` since its own sticky background (below) otherwise wins.
  - The Constituency/region-name column (`td:first-child`/`th:first-child`) is now **sticky**
    (`position: sticky; left: 0`) within `.gd-vote-table` — this table runs Electorate through
    Status, wide enough that scrolling right to see the later columns previously scrolled the
    row's own identity (and the region row's own expand/collapse toggle) out of view along with
    it. The sticky header cell's `z-index` is bumped above the sticky body column so the top-left
    corner cell layers correctly; region/total rows get their own sticky-cell background override
    so the grey subtotal tint survives under the sticky positioning.
  - Two tickboxes (`columnToggleControls()`) above the table — "Electorate, Vote & Turnout" and
    "Spoil" — **both unchecked (columns hidden) by default**; checking one reveals its columns.
    Every cell in a group carries a `data-col-group="evt"`/`"spoil"` attribute (header cells in
    `voteTableHead()`, body cells via the new shared `colGroupTd()` helper in
    `appendTurnoutCells()`/`appendVoteCells()`/`appendRegionSubtotalCells()`); a tickbox's checked
    state just toggles a `hide-col-{group}` class on the `<table>` itself, and CSS
    (`table.data-table.gd-vote-table.hide-col-{group} [data-col-group='{group}']`) does the hiding
    — no per-toggle DOM rebuild or table walk. (An earlier version of this feature was built as a
    pair of stat-tile "ticket box" summaries above the table instead — scrapped once it became
    clear the actual request was a column-visibility control, not a summary display; no trace of
    the stat-tile version remains.)
- **Alma Vale vote-share header, and the drill-down summary box's majority sentence dropped,
  2026-08-04** (`js/pages/election-alma-vale.js`, `js/pages/election-overview.js`,
  `js/pages/election-common.js`, `js/data.js` — user-directed):
  - `election-alma-vale.html`'s vote-share bar now has a big-number/label header row above it,
    matching `index.html`'s seats-so-far header — the two pages now share one
    `spectrumSummaryRow(electionMeta, getContent)` implementation (moved into
    `election-common.js`; `election-overview.js`'s own version renamed `seatsSpectrumSummaryRow`
    and rewritten as a thin wrapper around the shared one) instead of two separate copies of the
    same absolutely-positioned Left/MR/Right ruler markup. The big number is that spectrum's
    decided-seat count within Alma Vale; the label reads `"{Party}: {Vote} ({Vote Pct})"` instead
    of just the spectrum name, via `buildSpectrumDisplayLabels()` (`localRepresentative.js`, newly
    re-exported from `js/data.js` for this) — the national display-party mapping is needed because
    Left is fielded by either NRD or LRP depending on constituency, so there's no single "the" Left
    party without it.
  - The constituency/county/precinct drill-down summary box's 1st-preference table
    (`round1Table()`) no longer appends a `"{Spectrum} wins outright with a first-round majority."`
    sentence under the majority row — the row is still bolded, just without the explanatory prose
    (same trim-the-prose-keep-the-data instinct as the Local Representative subtitle removal and
    the Home Districts sub-row caption removal, both logged above). The now-unused `spectrumLabel()`
    helper was deleted along with it.
- **Alma Vale geo layout added + map/list/tooltip "2nd Pref" runoff consistency overhaul,
  2026-08-04** (`election-alma-vale.html`, `js/pages/election-alma-vale.js`,
  `js/map/electionMap.js`, `js/map/resultsTable.js`, `js/data/supplementaryVote.js`,
  `js/data/results.js`, `js/data.js`, `js/nav.js`, `css/results.css`, `css/map.css` — crosses the
  original 2a/2b ownership split, fine post-launch, user-directed across a long iterative session):
  - **Geo layout**: `election-alma-vale.html`'s "Constituency map" section rebuilt as a two-column
    layout mirroring `referendum.html`'s `.ref-geo-layout` (this page's own equivalent is `.egeo-*`,
    `css/results.css`, since the two page families still don't share a stylesheet) — the map on the
    left, a right-hand panel on the right with the County/District toggle, "jump to
    Constituency/County-or-District/Precinct" level-switch buttons (only shown two/three levels
    deep, preserve the deeper selection when jumping back up so jumping back down restores it), a
    per-polygon "vote result" box, and a clickable summary list (Left/MR/Right + Status) that drills
    the map without touching the SVG. The old full-width map + separate below-the-fold vote table
    is gone; the vote table now lives in its own "Full results by constituency" section below the
    geo layout, same relationship `referendum.html`'s own flat General Direct table has to its geo
    section.
  - **`electionMap.js` legend/coloring simplified** the same way `referendumMap.js` already was
    (see that entry above): legend trimmed to the 3 spectrums only; Not received/Verifying/Counting
    collapsed to one neutral gray (`neutralColorVar()`) at every aggregate level, the map's
    under-shapes status-line sentences dropped (`updateBreadcrumbAndStatus` → `updateBreadcrumb`,
    breadcrumb trail itself kept).
  - **Shared "1st Pref" / "2nd Pref (actual)" toggle** (`election-alma-vale.js`'s `listPrefView`,
    controls card, below the County/District toggle) drives THREE surfaces from one switch: the
    summary list's Left/MR/Right columns, the vote-result box's round table, and — new
    `mountElectionMap(container, { resultView })` option / returned `setResultView(view)` method,
    no re-render needed since tooltips build live on hover — the map's own hover tooltip.
    `resultsTableHtml()` (`js/map/resultsTable.js`) gained a `view: '1st'|'2nd'` param dispatching to
    a new `singleRoundTableHtml()` (one `{round} Vote | Pct | C [D]` column pair instead of the
    legacy dual-1st-and-2nd-column table; the legacy shape is unchanged/still tested when `view` is
    omitted).
  - **Combined hypothetical-runoff table** (`hypotheticalRunoffTable()`, vote-result box's "2nd
    Pref" view) replaced an earlier "Eliminate X" chip-picker: one row per party + Spoil/NIL, one
    column per possible 2-spectrum pairing (L-MR / L-R / MR-R), all 3 scenarios visible at once via
    the new `Data.computeHypotheticalRunoff(totals, eliminated)` (`js/data/supplementaryVote.js`, a
    forced-elimination variant of `computeSupplementaryVote` — re-exported through `js/data.js`).
    Every column's own winner bolds regardless of which is real; the REAL column (when one exists)
    additionally gets a background tint in its winner's spectrum color instead of an explanatory
    sentence — the title gets a trailing `" (Hypothetical)"` instead, only when there's no real
    elimination to highlight at all (round1 already produced an outright majority constituency-wide).
  - **"One true runoff" consistency fix — the significant one.** Every sub-unit (county, district
    fragment, precinct) used to recompute its OWN locally-lowest-spectrum elimination independently
    from just its own votes, so two areas inside the SAME constituency could legitimately show two
    different "real" runoff pairings even though there is only one actual runoff for the whole seat
    (reported symptom: neighboring counties DR08/DR09 highlighting different real columns; a
    100%-Declared precinct reading "Pending" because its own local elimination didn't happen to
    match the constituency's). Fixed everywhere at once — the vote-result box, the summary list
    (new `unitActualRunoff(constituencySeat, round1, totals)` helper in `election-alma-vale.js`),
    and the map tooltip (`tooltipForSecond`/`tooltipForPrecinct` in `electionMap.js`, new
    `constituencyRoundTwoCertain()` helper) — now all derive round2/eliminated/nil from the
    CONSTITUENCY's own real `eliminated` spectrum applied to that unit's own totals via
    `Data.computeHypotheticalRunoff`, never a per-unit independent recompute. `roundTwoCertain`
    likewise always reads off the constituency's own certainty. This is also what fixed the stray
    "Pending" on fully-Declared precincts — there's no more per-unit "does this match the parent"
    check to fail, just one shared computation every level defers to.
  - **District mode's second-tier box + list unified with County mode**: both now fetch
    `Data.getAlmaValeSupplementaryVoteForShapeIds()` (real transfer-column data) instead of
    District's own FPTP-only `getAlmaValeFirstPreferenceWinnerForShapeIds()` for these two
    INFORMATIONAL displays — "2nd Pref" for a District now shows a genuine round-2 transfer
    breakdown (eliminated spectrum → 0) instead of silently repeating round 1 a second time. The
    map's own District-mode fill color and "D" confirmed-winner tick are UNCHANGED (still
    FPTP-plurality-based, per FEATURE_SPEC.md Section 4's Local Representative rule) — only what
    these two lists/boxes display changed, not what determines the map's own coloring.
  - **Precinct fill color simplified to always match the CONSTITUENCY's own overall
    `winnerSpectrum`** (`colorForPrecinct()`, same figure the Constituency/County/District shapes
    already color by) instead of that one precinct's own local vote lean — a precinct can (and
    normally does) lean a different spectrum than the seat as a whole; that's real, still fully
    visible in its own tooltip/panel results table, but the FILL now answers "who ultimately
    represents this whole seat," the same answer everywhere inside one constituency, not "how did
    this one precinct's own ballots break down." New `--precinct-tie` purple (`css/map.css`,
    `#9333ea`) is the last-resort fallback for the near-impossible case a whole constituency itself
    has no clear winner (an exact tie at that scale).
  - **Data-layer additions backing all of the above**: `computeHypotheticalRunoff()`
    (`supplementaryVote.js`, above); `getAlmaValeSeatDetail()`'s precinct entries now also carry
    `totals` (the raw 9 transfer-column sums) alongside `result`, so a single precinct's hypothetical
    runoff can be recomputed under an arbitrary elimination; `getAlmaValeFirstPreferenceWinnerForShapeIds()`
    now also returns `spectrumVotes` (the pre-relabel Left/Right/MR tally, alongside the existing
    display-party-relabeled `votesByParty`) for the summary list's Left/MR/Right columns in District
    mode. All additive — full data-layer test suite (`js/data/test/*.test.mjs`,
    `js/map/test/resultsTable.test.mjs`) still passes unmodified.
  - **Smaller UI cleanups along the way**: constituency codes now shown ahead of the name everywhere
    on this page ("C01 The City of Alington"); the vote-share bar's redundant small-grey
    vote/pct caption row under the bar was removed (the same figures already appear once, in the
    bold summary row above it); the page subheading trimmed to just "40 seats"; the site-wide nav
    brand (`js/nav.js`, every page) renamed "Election Results Demo" → "Election Results"
    (`map-demo.html`'s `<title>` updated to match).

- **2026-08-04 — General Election overview/results pages were taking ~4s to load ("Loading
  results…" hanging).** Root cause: `getOverview()`'s seat-type functions all call
  `shapes.js`'s `getShapeIndex()` purely to join `Shape_ID -> Constituency/District` for grouping
  results — but that function fetches ALL of `shapes/df_polygon.csv` (~8MB) and
  `shapes/df_districts.csv` (~1.7MB), which are almost entirely `geometry`/`centroid` WKT text
  needed only by the map renderer, never by a plain join. Fixed at the data layer, not by touching
  any map code:
  - **`scripts/build-lean-shapes.mjs`** (repo root, `Result Webpage/scripts/`) strips
    `geometry`/`centroid` out of `df_polygon.csv`/`df_county.csv`/`df_constituency.csv` into
    `*_lean.csv` siblings. Dependency-free — reuses `csv.js`'s `parseCSV` (no fetch/DOM dependency,
    imports straight into Node), no package.json/npm install needed.
    **2026-08-04, later same day — simplified deploy story**: this site is deployed via GitHub
    Pages (the repo's existing, already-working custom domain setup), which has no build step — it
    serves exactly what's committed. Originally tried wiring this script into a Render static-site
    build command instead (`render.yaml` at the repo root still documents that path if ever
    needed), but that's a whole separate hosting platform, domain/DNS reconfiguration, etc. for a
    site with no server-side logic at all. Simpler: the `*_lean.csv` outputs are committed to git
    like any other data file (NOT gitignored) and just get regenerated + re-committed by hand
    whenever `shapes/*.csv` changes (rare — "most CSV content is fixed" per the site's own data
    model). `run_site.bat` still runs the script before serving locally, purely so local dev never
    drifts from what's committed. (The script itself was briefly ported from an earlier Python
    version, `build_lean_shapes.py`, after Python turned out to not be a safe assumption in a
    generic static-site build image — moot now that no build step runs in production at all, but
    Node has no such availability risk either way.)
  - **`shapes.js`: new `getShapeJoinIndex()`** (+ `buildShapeJoinIndexFromRows()`, tested in
    `shapes.test.mjs`), a lighter sibling of `getShapeIndex()` that loads only the lean files and
    builds just `{polygonById, polygonsByCounty, countiesByZone, constituencies}` — no geometry, no
    `df_districts.csv`/`df_authority.csv` at all (neither is needed for a plain join).
    `getShapeIndex()` itself is completely unchanged, still used as-is by every map-rendering page
    (`electionMap.js`, `referendumMap.js`, `election-alma-vale.js`, `referendum.js`'s map path).
  - **`results.js`** (all 4 call sites: `getAlmaValeSeats`, `getAlmaValeSeatDetail`,
    `getLocalRepresentativeSeat`, `buildLocalRepresentativeProportionalSector`) and
    **`referendum.js`** (`getAlmaValeReferendumForAuthority`/`ForCounty`) switched from
    `getShapeIndex()` to `getShapeJoinIndex()` — verified by grep that neither module ever reads
    `.geometry`/`.centroid`/`.districtFragments`/`.authorities` off the shape index, only
    `.polygonById`/`.polygonsByCounty`/`.countiesByZone`/`.constituencies`.
  - Net effect: the overview/seat-list/referendum-rollup pages' shape payload drops from ~10.2MB
    (5 full files) to ~1.66MB (3 lean files), and they no longer fetch `df_districts.csv`/
    `df_authority.csv` at all. Full `js/data/test/*.test.mjs` suite still passes.
  - Per-path `Cache-Control` tuning (long-lived immutable for fixed shape/meta files, short
    revalidate for results/referendum files that change as counts come in) isn't available on
    plain GitHub Pages — it doesn't support custom response headers. Not pursued further since it's
    a smaller win layered on top of the payload-size fix above, not a prerequisite for it.

# Election Results Demo — Feature Spec

Status: **implemented**. `election-site/` (in this folder) is built against this spec end-to-end — data layer, synthetic data, choropleth maps, General Election pages, and the Referendum page are all live. This file remains the source of truth; see "Open items" below for the judgment calls the build made where this doc didn't fully pin something down, and `election-site/BUILD_NOTES.md` for build-level (not spec-level) history.

---

## 1. Data hierarchy & map layers (General Election)

Three display layers, drilling top → bottom:

1. **Constituency** — default view, all 40 constituencies
2. **County or District** — second layer, chosen by a **site-wide toggle** (whole site is in one mode at a time, not per-constituency)
3. **Precinct** (`Polygon` in the existing CSVs) — bottom layer

(The Referendum page uses a different, fixed pair of layers — Authority → County — see Section 5.)

**Nesting rule, verified against the actual data 2026-08-02**:
- Every polygon maps to exactly one `County` and one `District` (`df_polygon.csv` columns) — confirmed, no orphans.
- Every county maps to exactly one `Constituency` **and** exactly one `Zone` — both are always present on every `df_county.csv` row, they are not mutually exclusive alternatives.
- **`Zone` (in `df_county.csv`) and `Authority` (in `df_authority.csv`) are the same 36-value set, joined by name only** — there is no literal `Authority` column anywhere except `df_authority.csv` itself. To go from a precinct/county up to its Authority: `df_polygon.csv.County` → `df_county.csv.County` (gives `Zone`) → `df_authority.csv.Authority` (match on name). This 2-hop join works for all 20,850 precincts with no gaps (verified).
- **Districts do *not* always map to exactly one constituency** — 12 of the districts (e.g. `Alington City`: 50 precincts in `The City of Alington`, 37 in `Upper Alington`) genuinely straddle two constituencies. Counties never do this (every county maps to exactly one constituency).

**Split-district handling**: when the second layer is in District mode and the user has drilled into a specific Constituency, a split district shows **only the precincts within that constituency** — filter by `District` AND the active `Constituency` together (both columns already exist per-precinct in `df_polygon.csv`, so no extra join is needed). The same district shows its full extent when viewed unfiltered (top-level County/District mode without a constituency drill-down active).

**Result files key by `Shape_ID` only** — no redundant Constituency/County/District/Authority columns. Those are looked up by joining to `df_polygon.csv`.

**Drill-down**: click a constituency → show its second-layer units; click a second-layer unit → show its precincts; **reset button** returns to the top view.

**Load limiting**: to avoid rendering >10,000 polygons at once, clicking a unit loads only its children **plus the children of neighboring units** at the same level. Neighbors are computed from shared polygon borders (geometric adjacency, precomputed at data-build time — same approach as `AdjacencyGraph.js` in the existing editor tool). **Superseded 2026-08-04 — see Open Items**: neither live map component actually implements this; both use a different technique (render every top-level unit always, expand one path at a time in place) that satisfies the same >10,000-shape constraint without geometric adjacency. `getUnitAndNeighborIds`/`getAdjacency` remain implemented and tested in the data layer, just unused by the maps.

**Presentation order for constituencies**: anywhere the site lists/enumerates constituencies (nav menus, the Alma Vale seat list, etc.), group by `Region` (`df_constituency.csv`'s `Region` column — e.g. Capital, Highland, Lowland) and sort within each region by `Constituency_Code` ascending. `Constituency_Code` is manually assigned per region (e.g. `C01`–`C20` for Capital, `H01`–`H10` for Highland, `SE01`–`SE10` for Lowland) — it is the authoritative display order, not alphabetical and not file row order.

---

## 2. Time-gating ("announced before now")

Every precinct result row carries `received_at`, `verified_at`, `declared_at`, compared against **real wall-clock time**.

| Status | Condition | Visible |
|---|---|---|
| Not received | `received_at` null or future | nothing |
| Verifying | `received_at` ≤ now | received, unverified |
| Counting | `verified_at` ≤ now | turnout |
| Declared | `declared_at` ≤ now | full result |

Parent levels aggregate from whichever children have reached each status (no waiting for 100%). Each level shows a **% declared** figure, **electorate-weighted** (sum of `Electorate` for Declared precincts ÷ total `Electorate` for the level) — not a plain precinct count.

A precinct's General Election and Referendum results share the same `received_at`/`verified_at`/`declared_at` — one physical ballot box, reported once, feeding both result files.

---

## 3. Choropleth map, spectrums & parties

There are two levels: **3 spectrums** (broad ideological blocs, used for map coloring and SupplementaryVote races) and **5 parties** (actual contestants, each belonging to one spectrum, used for HareQuotaLRM/Proportional races). Source: `Parties_Side.xlsx`, embedded directly in `election_meta.json`'s `spectrums[]`/`parties[]` arrays — no separate `df_parties.csv` (would just duplicate the JSON; `Color` in the source spreadsheet was unfilled and unused anyway).

| Spectrum | Color |
|---|---|
| Left | Blue |
| Middle Right | Yellow |
| Right | Red |

| Party | Abbreviation | Spectrum |
|---|---|---|
| Neo Rational Democrats | NRD | Left |
| Liberal Democratic Party | LRP | Left |
| Glory Restoration Frontier | GRF | Middle Right |
| Grassroot-Civic Cooperation Alliance | GCCA | Right |
| Rural Alliance | RA | Right |

**Rule**: SupplementaryVote seats field exactly **one party per spectrum** — so those races' columns stay spectrum-labeled (`Left_Left`, `Right_Right`, etc.), and the specific fielded party's full name/abbreviation is looked up from `election_meta.json`'s `parties[]` for display purposes only. HareQuotaLRM/Proportional seats can field **multiple parties from the same spectrum** competing against each other (e.g. NRD vs LRP, both Left) — those races' result columns are actual party abbreviations, not spectrum labels. Which specific parties contest a Proportional race, and how they're coalesced into lists, is declared via `lists[]` on the `GeneralProportional` entry in `election_meta.json` (see Section 4).

- No candidate names shown anywhere, at any level — spectrum or party name only, never an individual.
- Precinct status label: `Not received` / `Verifying` / `Counting` / `Declared`.
- Declared precincts colored by leading spectrum (other encodings like margin/turnout are out of scope for v1). Party-level bars (Section 4) use shades of the parent spectrum's color, consistent across both SupplementaryVote and Proportional displays.

**`df_party_participation.csv`** — one row per SupplementaryVote seat (55 rows: 40 Alma Vale + 5 Home Districts + 10 General Direct), keyed by `Seat_Type, Constituency, Sub_Constituency`, with six participation columns: `Left_Participate, Left_Party, MR_Participate, MR_Party, Right_Participate, Right_Party`. `*_Participate` is `yes`/`no`; `*_Party` is the specific abbreviation fielded when participating (blank when not). This exists because a wide results CSV can't distinguish "this spectrum didn't field a candidate here" from "it fielded one and got 0 votes" — `*_Participate` flags were derived from the data where possible (e.g. `df_results_13d.csv` has every `MR_*` column blank throughout → MR doesn't participate in Home Districts; `df_results_general_direct.csv` has real `MR_MR` figures throughout → MR does participate there). All 55 rows now have real `*_Party` assignments filled in (no `TBD` placeholders remain).

---

## 4. Seats & results — General Election *(main/home page)*

| Seat type | Count | Method |
|---|---|---|
| Alma Vale | 40 | Supplementary Vote (one per constituency) |
| Home Districts | 5 | Supplementary Vote — one seat per `Constituency`, see basis rule below |
| General Direct | 10 | Supplementary Vote — one seat per `Constituency`, see basis rule below |
| General Proportional | 45 | Proportional — two-stage Hare quota + largest remainder, national basis (see below) |

**Election methods used**
- **Supplementary Vote**: single winner. A party wins outright with >50% of first-preference votes. Otherwise, eliminate the lowest party and redistribute its votes via the second-preference transfer columns; winner is whoever leads the remaining two parties after redistribution.
- **Proportional**: multi-winner, two-stage Hare quota + largest remainder method with list coalitions and a 15% gate — see the dedicated subsection below.

**Vote-transfer schema (Alma Vale, and any other Supplementary Vote seat)** — per precinct: `Electorate`, `Turnout` (ballots cast), the 9 first-preference × second-preference columns, and `Spoil` (spoiled/invalid ballots):

```
Left_Left, Left_Right, Left_MR, Right_Left, Right_Right, Right_MR, MR_Left, MR_Right, MR_MR
```

Self-referential columns (`Left_Left`, `Right_Right`, `MR_MR`) mean *no second preference* — that ballot becomes **NIL** (exhausted) if its first-preference party is eliminated. Confirmed.

`Turnout + Spoil ≤ Electorate`; the 9 transfer columns should sum to `Turnout − Spoil`.

**Results display**
- Round 1: bar chart of all 9 columns — each party's three columns shown as three shades of that party's color (three blue shades for Left_*, etc.)
- Round 2 (only when triggered): bar chart of the two remaining parties + NIL
- Site structure: overview (seats won per party, by seat type) → seat type → individual seat detail (constituency map, precinct breakdown, status)

**Declaring a winner before every row has reported** (added 2026-08-04, per user direction — see Open Items below for a math correction made along the way): for any Supplementary Vote seat (Alma Vale, Home Districts, General Direct), a winner is shown as final once it's **mathematically certain** the outstanding undeclared ballots can no longer change the outcome — not necessarily only once every backing row is literally Declared. The **undecided pool** for a seat sums, per not-yet-Declared row: its full `Electorate` if turnout itself isn't known yet (Not received/Verifying), or its verified `Turnout` if Counting but not yet Declared (the conservative worst case either way). Three certainty checks run against that pool, in order:
1. **Outright round-1 majority certain**: the leader's current lead over BOTH other spectrums combined exceeds the undecided pool (`leader − (others) > undecided`) — the leader's share can't drop to ≤50% however the outstanding ballots land.
2. **A runoff is unavoidable**: even the leader's best case (every outstanding ballot going to the leader) still can't clear 50% (`(others) − leader ≥ undecided`).
3. **Which two spectrums make the runoff is certain**: the current #2's lead over #3 exceeds the undecided pool — #3 can never catch #2, so #1/#2 are locked in as the runoff pair regardless of whether the runoff itself is certain yet.

Once the runoff pair is locked in, check 1's same two-way majority logic runs again on the round-2 tally to decide whether the runoff's own winner is certain. Until a seat clears the relevant check, its Final/round-2 figures read "Undecided" (list tables) or "Pending" (map tooltips) rather than a possibly-premature number. Implemented in `js/data/supplementaryVote.js`'s `resolveSupplementaryVoteCertainty()`, fed by `js/data/results.js`'s `computeUndecidedVotes()`; every seat/sub-row summary carries the result as a `certainty` field alongside the always-present (but not necessarily final) `winnerSpectrum`/`winnerParty`. Does **not** apply to General Proportional (its own guaranteed-minimum method above already separates provisional from final) or to the derived `Local Representative` seat (its own margin-safe rule, below, applies instead — FPTP-over-Districts, not Supplementary Vote).

**Home Districts / General Direct / General Proportional — separate result files**

These three seat types are *not* precinct-level (`Shape_ID`) — each has its own result file, keyed by `Constituency` + `Sub_Constituency`. When `Constituency == Sub_Constituency`, there is no sub-layer and the row displays flat (no expand arrow); otherwise the UI shows `Constituency` as a collapsible/expandable row containing its `Sub_Constituency` rows.

**General Direct is a functional constituency, not a geographic one — confirmed.** Its `Constituency` values (`Swift`, `Planning and Research`, `Finance Management`, etc.) are organizational/sector groupings with no tie to real places. It **never appears on the choropleth map**, on the General Election page or the Referendum page — table only, one flat hierarchy (its own seat list), not the Constituency → County/District → Precinct layering Alma Vale gets (Section 1). This is specific to General Direct as stated — Home Districts' status is unconfirmed (its names — `Tong`, `Diamond & Rainbow SE`, etc. — look place-like) and isn't covered by this rule unless said otherwise.

**Basis for Home Districts and General Direct: `Constituency`.** The `Constituency` column *is* the seat — one seat per unique `Constituency` value (5 for Home Districts, 10 for General Direct). When a `Constituency` has more than one row (multiple `Sub_Constituency` children), that seat's result is the **sum of votes across all its sub-rows** — the sub-rows are reporting granularity, not separate seats. This matches how Alma Vale's `basis` already works (`Constituency`), just applied through an extra layer of sub-row aggregation.

- **Home Districts, General Direct** (`method: SupplementaryVote`): same shape as the Alma Vale schema, minus `Shape_ID`, plus the two name columns:
  `Constituency, Sub_Constituency, Electorate, Turnout, Left_Left, Left_Right, Left_MR, Right_Left, Right_Right, Right_MR, MR_Left, MR_Right, MR_MR, Spoil, received_at, verified_at, declared_at`
- **General Proportional** (`method: HareQuotaLRM`): simple per-party vote totals, no preference transfer. Columns after `Turnout` are **actual party abbreviations** (not fixed spectrum labels), since multiple same-spectrum parties can compete here — e.g. current sample data uses `Constituency, Sub_Constituency, Electorate, Turnout, NRD, LRP, GRF, GCCA, Spoil, received_at, verified_at, declared_at`. The exact party-column set is whatever `lists[]` on the `GeneralProportional` entry in `election_meta.json` says is fielded (see below).

Each `seat_types[]` entry in `election_meta.json` now carries a `results_file` field naming its backing CSV — the JSON is the manifest, no file names need to be hardcoded in code.

**General Proportional — the allocation algorithm**

The 10 `Constituency`/`Sub_Constituency` rows in `df_results_general_proportional.csv` are **reporting granularity only** — each row's `received_at`/`verified_at`/`declared_at` gates when *that sector's* votes count toward the national picture (same status pipeline as everywhere else, Section 2). The seat allocation itself runs **once, nationally, on the sum across all 10 sectors** — this resolves the `basis` open item: **basis = national**, not per-sector.

1. **Lists**: parties in the same spectrum may run as one combined "list" (pooling votes for seat allocation) or stay separate. A spectrum with only one participating party is automatically a list of one (this is how `GRF` and `Right` behave today — see `lists[]` below).
2. **Valid votes / Total votes / Turnout**: `Valid Votes` = sum of every party's votes across all sectors; `Total Votes` = `Valid Votes + Spoil`; a party or list's `Percent` = its votes ÷ `Valid Votes`; `Spoil`'s `Percent` = `Spoil ÷ Total Votes` (different denominator); `Turnout` = `Total Votes ÷ Electorate`.
3. **15% gate**: a list must reach ≥15% of `Valid Votes` to qualify for any seats — equivalently ≥ `0.15 × Valid Votes` raw votes (worth surfacing on the results page as a raw number, e.g. "Gate: 23,975 votes"). Lists below the gate get zero seats and are excluded from the quota math entirely.
4. **Stage 1 — seats per list**: national quota = `Valid Votes ÷ 45`. Each qualifying list's raw entitlement = `list votes ÷ quota`. Award `floor(raw entitlement)` seats to each list, then give the remaining unallocated seats one at a time to whichever qualifying lists have the largest fractional remainder, until all 45 are allocated.
5. **Stage 2 — seats within a list**: for any list with 2+ member parties, re-run Hare quota + largest remainder *within* the list — list-internal quota = `list votes ÷ seats the list won in Stage 1`, each member party's raw entitlement = `party votes ÷ list-internal quota`, floor + largest-remainder to split the list's seats among its parties. A single-party list skips this — its Stage 1 seats go entirely to its one party.
6. **No candidate cap**: every list fields a full national slate (45 candidates), so a list/party can never be short of candidates for the seats it's awarded — no overflow rule needed. (The reference screenshot's `Competing` column, which varied per party, does not apply here and was never added to the data model.)
7. **Provisional seats, before all 10 sectors are Declared** (added 2026-08-04): Stage 1/2 above assumes `Valid Votes` is the *final* national total — mid-count it's only whatever's counted in Declared sectors so far, and running the same floor + largest-remainder math on a partial total is wrong twice over: largest-remainder always hands out all 45 seats even off one reporting sector, and a list's *share* of votes-counted-so-far can rise or fall as more sectors report even though its raw vote count never does — so seats computed that way could visibly go backwards as the count progresses. Until every sector is Declared, each list/party is instead credited its **guaranteed-minimum** seats — the number it would keep no matter how every outstanding sector eventually breaks:
   - **Gate**: a list qualifies once its raw votes-so-far ≥ `15% × Electorate` (the full national electorate, not 15% of votes counted so far).
   - **Seats**: `floor(party's votes-so-far × 45 ÷ Electorate)` per party, summed to the list. No largest-remainder top-up runs here, so seats can (and usually will) sum to fewer than 45 — the remainder is undetermined, not assigned to anyone.
   - Both figures substitute `Electorate` for `Valid Votes`: since no voter can cast more than one ballot, final `Valid Votes` can never exceed `Electorate`, so this always matches-or-undershoots what Stage 1/2 would eventually award, never overshoots it. Combined with `Electorate` being fixed from the start and a party's counted votes only ever growing as sectors declare, a list's guaranteed-minimum seats can only hold steady or climb while sectors are outstanding — never drop — and are never later revealed to have been an overstatement once Stage 1/2 takes over at 100% declared. Implemented in `js/data/proportional.js`'s `computeGuaranteedMinimumAllocation()`.

Verified worked example (45 seats, Valid Votes = 159,833, quota = 3,551.84, gate = 23,975):

| | Votes | % of Valid | List | List votes | Stage 1 (list seats) | Stage 2 (party seats) |
|---|---|---|---|---|---|---|
| NRD | 36,894 | 23.08% | Left | 68,036 | 19 | **10** |
| LRP | 31,142 | 19.48% | Left | 68,036 | 19 | **9** |
| GRF | 67,288 | 42.10% | MR | 67,288 | 19 | **19** |
| GCCA | 24,509 | 15.33% | Right | 24,509 | 7 | **7** |
| Spoil | 3,234 | 1.98% *(% of Total Votes, 163,067)* | — | — | — | — |

`election_meta.json`'s `GeneralProportional` entry now carries `threshold_pct: 15` and a `lists[]` structure (replacing the flat `participating_parties` array) to express which parties are coalesced — `lists[]` is a strict superset of `participating_parties` (flattening it recovers the old array), so this wasn't a breaking change, just more explicit:

```json
"lists": [
  { "id": "Left", "parties": ["NRD", "LRP"] },
  { "id": "MR", "parties": ["GRF"] },
  { "id": "Right", "parties": ["GCCA"] }
]
```

**Derived seat: `Local Representative` in General Direct (one-off, confirmed)**

`Local Representative` is a **one-off special case**, not a general pattern — no other row in any Supplementary Vote results file works this way. Its result is **derived** from `df_results_alma_vale.csv` rather than having its own ballot data, so its row in `df_results_general_direct.csv` (and its counterpart in `df_results_generaldirect_referendum1.csv`) is **entirely blank** — every column, including `Constituency`/`Sub_Constituency`, not just the vote/timestamp columns. Its seat identity (that a `Local Representative` seat exists at all, as one of General Direct's 10) lives only in `df_party_participation.csv`, which still carries `Constituency = Sub_Constituency = "Local Representative"` for it — the results file intentionally carries zero primary data for a seat that has none.

Derivation rule:
1. Take precinct-level votes from `df_results_alma_vale.csv`, join each precinct to its **District** via `df_polygon.csv`. "District" here means each `(District, District_Ward)` row of `data/shapes/df_districts.csv` (~1,779 of them) — not the ~37 broader District *names* those rows group under (the UI calls that grouping a "council"; see the Open Items entry below for why this needed clarifying). A precinct's own `District`/`District_Ward` columns already identify which unit it belongs to, no extra join to `df_districts.csv` needed for the tally itself.
2. Sum votes per party within each District; whichever party has the plurality (highest vote) wins that District. A District only counts once **every** one of its precincts is Declared — a partially-Declared District (some but not all precincts reported) contributes no votes and shows as undeclared, since its plurality could still flip. NRD and LRP votes are pooled under one `LRP` label for this tally specifically (see Open Items below) — every other spectrum only ever fields one party.
3. The party that wins the most Districts overall is awarded the `Local Representative` seat.

**Declaring a winner before every District has reported** (added 2026-08-04, per user direction): there is no second round for this seat, so a party is only declared the winner once it's mathematically safe — the number of Districts still undeclared must be **smaller than its margin over the runner-up** (Districts won so far), since the trailing party's best possible outcome is sweeping every remaining undeclared District. Until then the header shows plain "Undecided" text (no leading-party pill — a partial lead isn't a result). Once every District has actually reported (0 remaining), the tally is final regardless of margin, including a genuine tie. Implemented in `js/data/localRepresentative.js`'s `marginSafeResult()`; surfaced as `seatWinner` (null until safe)/`currentLeader` (who's ahead right now, safe or not)/`margin`/`districtsRemaining`/`isFinal` on the derivation result, and as `winnerParty`/`isFinal` on the shaped seat from `getGeneralDirectSeats()`.

On the results page, clicking a derived seat like `Local Representative` routes to a sub-page showing the vote breakdown by party **per District/council**, rather than the precinct-breakdown view used for directly-voted seats.

**File naming conventions**:
- **General Election seat results**: `df_results_{slug(name)}.csv`, where `slug()` lowercases the seat type's `name` field and replaces spaces with underscores (e.g. `"General Direct"` → `df_results_general_direct.csv`, `"13D"` → `df_results_13d.csv`). The `results_file` value in `election_meta.json` must always match — if a seat type's `name` changes, its file must be renamed and `results_file` updated in the same edit.
- **Referendum seat results**: `df_results_{id.lower()}_referendum{N}.csv` — note this uses the seat type's `id` (PascalCase, no spaces — `AlmaVale` → `almavale`, `GeneralDirect` → `generaldirect`), **not** the slugified `name` used above. Deliberately different: `id` is stable even if a seat type's display `name` changes later, so referendum files don't need renaming when `name` does. `{N}` is the `referendum_id`.
- **Paths**: `results_file` values in both `election_meta.json` and `referendum_meta.json` are paths **relative to the data root** (`data/`), not bare filenames — e.g. `results/df_results_general_direct.csv`, `referendum/df_results_almavale_referendum1.csv` — reflecting the folder layout in Section 8.

---

## 5. Referendum page

Separate page from the General Election. One referendum question/page for now; the data model supports more (see below).

**Display layers are fixed: Authority (top) → County (second) → Precinct (bottom)** — same 3-layer drill depth as the General Election, but Authority/County instead of Constituency/County-or-District (Section 1), and no toggle. This is separate from which seat types supply the underlying vote data (below) — the layer model is about how results are *displayed*, seat-type scoping is about which raw ballot data *feeds* them.

**Scoped by seat type.** A referendum question's votes come only from specific seat types — e.g. `AlmaVale` + `GeneralDirect` — not necessarily everywhere. `referendum_meta.json`'s `seat_types[]` array lists which ones, each with its own `results_file`:

```
"seat_types": [
  { "id": "AlmaVale", "results_file": "referendum/df_results_almavale_referendum1.csv" },
  { "id": "GeneralDirect", "results_file": "referendum/df_results_generaldirect_referendum1.csv" }
]
```

Each `df_results_{seat_type_id}_referendum{N}.csv` carries the same columns as the old single-file model: `{key columns}, Electorate, Turnout, Yes_Votes, No_Votes, received_at, verified_at, declared_at`.

**Reconciling the two — only geographic seat types need to reach the Authority → County map:**
- `AlmaVale` (`Shape_ID`-keyed): works today. Every precinct joins `Shape_ID` → `County` (`df_polygon.csv`) → `Zone` (`df_county.csv`) → `Authority` (`df_authority.csv`, matched by name — see Section 1) with zero gaps across all 20,850 precincts (verified 2026-08-02). Its referendum votes render on the Authority/County choropleth.
- `GeneralDirect` (`Constituency`/`Sub_Constituency`-keyed): **doesn't need to** — General Direct is a functional constituency (Section 4), not geographic, and never appears on any choropleth map, referendum included. Its referendum votes (`df_results_generaldirect_referendum1.csv`) are shown in their own flat table on the referendum page, exactly like its General Election table — no join to Authority/County required. (The earlier finding that its `Constituency` values have zero overlap with real place names isn't a data gap to fix; it's expected, since those values were never meant to be geographic.)

A second question just adds a new `referendum_id`, its own `df_results_{seat_type_id}_referendum{N}.csv` file(s) for whichever seat types it's scoped to, and a second meta file (or a second entry, if `referendum_meta.json` becomes a list) — no schema change either way.

---

## 6. Hosting & non-goals

- No in-page CSV/file picker — data is pre-baked and served from a fixed backend location (e.g. static files on GitHub), fetched automatically.
- Static-first: no live feed, no auth/admin panel.
- Out of scope: polygon editing (separate existing tool), candidate-level detail, multi-race ballots, historical comparisons.

---

## 7. Synthetic test data

Build agent(s) generate simulated result data (votes, timestamps, turnout) to exercise the full status pipeline and both election methods end-to-end. Column layout open to the agent's proposal except where this doc already fixes a schema (the 9-column transfer format above).

**Simulation checklist (audited 2026-08-02)** — shape/demographic CSVs (`df_polygon`, `df_districts`, `df_county`, `df_authority`, `df_constituency`) are fully populated and are *not* simulation targets. Everything below is:

| File | Missing |
|---|---|
| `df_results_alma_vale.csv` | Entire file — 0/20,850 precinct rows |
| `df_results_almavale_referendum1.csv` | `Electorate`, `Turnout`, `Yes_Votes`, `No_Votes`, and all 3 timestamps — 100% blank on all 20,850 rows (only `Shape_ID` is filled) |
| `df_results_13d.csv` | All 3 timestamps — 100% blank on all 12 rows. (`MR_Left`/`MR_Right`/`MR_MR` blank is *not* missing — MR doesn't contest Home Districts, see Section 3.) |
| `df_results_general_direct.csv` | All 3 timestamps — 100% blank on all 13 rows. (The 1 entirely-blank row, `Local Representative`, is a derived seat — not missing, see Section 4.) |
| `df_results_general_proportional.csv` | All 3 timestamps — 100% blank; rows are the same 10 sectors as `df_results_general_direct.csv` (reporting granularity, not seats — see Section 4), current 15 rows are sample/WIP and don't yet cleanly cover all 10 sectors |
| `df_results_generaldirect_referendum1.csv` | `Yes_Votes`, `No_Votes`, and all 3 timestamps — 100% blank on all 13 rows |

No `df_party_participation.csv` gaps — its one blank column (`MR_Party` on the 5 Home Districts rows) is correct, matching `MR_Participate = no`.

---

## 8. Data files (current, in `data/`)

Organized into subfolders by role:

```
data/
  shapes/       geometry + demographics (unchanged, pre-existing)
  results/      General Election seat results (per seat type)
  referendum/   referendum results + referendum_meta.json
  meta/         election_meta.json, df_party_participation.csv, Parties_Side.xlsx
```

`results_file` values in both JSON manifests are paths relative to `data/` (e.g. `results/df_results_alma_vale.csv`) — see the naming-convention note in Section 4.

**`shapes/`** — geometry/demographic CSVs, untouched by the election data model: `df_polygon.csv` (20,850 precincts), `df_districts.csv`, `df_county.csv`, `df_authority.csv` (36 authorities), `df_constituency.csv` (40 constituencies — matches `df_party_participation.csv`'s Alma Vale set exactly, re-verified 2026-08-02; carries `Constituency_Code` + `Region`, see Section 1's presentation-order rule).

**`results/`, `referendum/`, `meta/`** (this spec's contract):

| File | Columns | Rows (current / expected) |
|---|---|---|
| `results/df_results_alma_vale.csv` | `Shape_ID, Electorate, Turnout, Left_Left, Left_Right, Left_MR, Right_Left, Right_Right, Right_MR, MR_Left, MR_Right, MR_MR, Spoil, received_at, verified_at, declared_at` | 0 / 20,850 — not yet populated |
| `results/df_results_13d.csv` (Home Districts) | `Constituency, Sub_Constituency, Electorate, Turnout, Left_Left, Left_Right, Left_MR, Right_Left, Right_Right, Right_MR, MR_Left, MR_Right, MR_MR, Spoil, received_at, verified_at, declared_at` | 12 rows / 5 seats (grouped by `Constituency`) |
| `results/df_results_general_direct.csv` | same columns as `df_results_13d.csv` | 13 rows / 10 seats (grouped by `Constituency`, matching Home Districts) |
| `results/df_results_general_proportional.csv` | `Constituency, Sub_Constituency, Electorate, Turnout, {party abbreviations...}, Spoil, received_at, verified_at, declared_at` — party columns per `election_meta.json`'s `lists[]`; rows are per-sector reporting granularity, seats are allocated nationally on the sum (Section 4) | 15 sector-rows — final seat math needs all 10 sectors declared, not 45 rows |
| `meta/df_party_participation.csv` | `Seat_Type, Constituency, Sub_Constituency, Left_Participate, Left_Party, MR_Participate, MR_Party, Right_Participate, Right_Party` | 55 / 55 — complete (40 Alma Vale + 5 Home Districts + 10 General Direct) |
| `referendum/df_results_almavale_referendum1.csv` | `Shape_ID, Electorate, Turnout, Yes_Votes, No_Votes, received_at, verified_at, declared_at` | 20,850 / 20,850 — `Shape_ID` filled from `df_polygon.csv`, vote/timestamp columns pending |
| `referendum/df_results_generaldirect_referendum1.csv` | `Constituency, Sub_Constituency, Electorate, Turnout, Yes_Votes, No_Votes, received_at, verified_at, declared_at` | 13 / 13 — ID/`Electorate`/`Turnout` copied from `df_results_general_direct.csv`, vote/timestamp columns pending |
| `meta/election_meta.json` | `election_id, election_name, election_date, election_type, has_referendum, spectrums[] {id, name, color}, parties[] {abbreviation, name, spectrum}` *(the party roster — no separate CSV)*, `seat_types[] {id, name, count, method, basis, results_file, threshold_pct?, lists?[] {id, parties[]}}` | — |
| `referendum/referendum_meta.json` | `referendum_id, question, election_date, seat_types[] {id, results_file}` | — |
| `meta/Parties_Side.xlsx` | source spreadsheet for the party roster (`spectrums[]`/`parties[]` in `election_meta.json`) | — |

**Audited 2026-08-02**: all column headers match this contract exactly; `Shape_ID` sets match 1:1 between `df_polygon.csv` and the Alma Vale referendum file with no duplicates; `df_constituency.csv`'s 40 constituencies match `df_party_participation.csv`'s Alma Vale set exactly, and `df_polygon.csv`/`df_districts.csv`/`df_county.csv` have no orphaned Constituency values; General Direct/Home Districts grouping keys match `df_party_participation.csv` exactly; all party abbreviations in use are valid against `election_meta.json`; the `Turnout + Spoil ≤ Electorate` invariant holds wherever checkable. No open structural mismatches.

**Typo pass 2026-08-02**: full whitespace + naming scan across every CSV. Fixed: `decleared_at` → `declared_at` in `df_results_general_proportional.csv`; trailing-space split on District `"Alma Causeway "` vs `"Alma Causeway"` across `df_county.csv`/`df_districts.csv`/`df_polygon.csv` (trimmed to the clean form); `"Finance Mangement"` → `"Finance Management"` across the 4 files it appeared in; trailing space on Sub_Constituency `"Outland "` in `df_results_13d.csv`. No further whitespace or spelling issues found.

---

## Open items

None currently open.

Resolved 2026-08-03 (build): a handful of judgment calls the build made where this doc described the rule but not every last detail — recorded here per the same convention, not because the doc was wrong, just incomplete:
- **Home Districts gets no map, same as General Direct.** Section 4 explicitly settles this for General Direct but leaves Home Districts as "status unconfirmed... names look place-like." Checked: `df_results_13d.csv`'s `Constituency` values (`Tong`, `Diamond & Rainbow SE`, `Shek East and Central`, …) have zero overlap with `df_constituency.csv`'s 40 real constituencies — confirmed by diff, not just visual similarity. So there's no valid map to lock onto; Home Districts renders table-only, same as General Direct, for a different underlying reason (no matching geometry, vs. General Direct's "not geographic at all").
- **Where the default, unlocked, all-40 Constituency map lives**: Section 1 describes the 3-layer drill-down but never says which page hosts the top-level (undrilled) view. Built it into the Alma Vale seat-type page (`election-alma-vale.html`) rather than the overview/home page, since Alma Vale's 40 seats *are* the 40 real constituencies one-to-one — the individual seat-detail page also gets a map, pre-drilled into (and reset-locked to) just that one seat's constituency.
- **The County/District toggle is genuinely site-wide** (Section 1 says so explicitly), implemented as one shared `localStorage` key read by every map mount — switching mode on the Alma Vale page's map carries over to a seat-detail page's map and back, not two independent per-page toggles that happen to look the same.
- **Region presentation order** (Capital, Highland, Lowland — Section 1) is alphabetical. The doc gives one example in that order but never states the ordering rule explicitly; alphabetical was the simplest reading and happens to match the one example given.
- **District second-layer geometry is many small fragment rows per district name, not one polygon per district** (unlike County, which is a clean 1:1). E.g. a district's shape is assembled from dozens of ward-sized fragment rows sharing one `District`/`District_ID` pair — and `(District, District_ID)` itself isn't even a unique key (`"Alma Causeway"` / ID `1` appears twice with different geometry). Not spelled out in this doc; the build groups fragments under one adjacency/unit id per District name and never relies on `(District, District_ID)` as a key. **Superseded 2026-08-04 — see below**: `df_districts.csv` was regenerated with its own `District_Ward` column, the `(District, District_ID)` duplicate cited above no longer exists, and the fragment-to-precinct join was rebuilt on an exact label match instead of the spatial workaround this bullet describes.
- **`GeneralProportional`'s `Right` vote column doesn't map to any entry in `parties[]`** (`parties[]` has `GCCA`/`RA` for the Right spectrum; the CSV/worked example in Section 4 both use the literal column name `Right` instead). Implemented literally as its own party-like abbreviation for this one race, displayed as `"Right"` when a `parties[]` name lookup misses, rather than guessing it means GCCA or RA. **Superseded 2026-08-04 — see below**: the data itself was corrected instead, so this is no longer live behavior.
- **Proportional gate-exclusion edge case**: Section 4's Stage 1 formula (`quota = Valid Votes ÷ 45`, using all valid votes including gated-out lists in the numerator) can allocate fewer than 45 seats total when a gated-out list holds enough votes to matter — the spec's own worked example never exercises this case. Implemented literally per the stated formula rather than patched to force exactly 45; a scenario with a large gated-out list will show a seat total below 45. **Superseded 2026-08-11 — see below**: patched, user-directed — quota's denominator now excludes gated-out lists' votes (not just the seat round), so all 45 seats always land on qualifying lists regardless of how large a gated-out list's share is.
- **`Local Representative`'s derivation** (Section 4: "sum votes per party within each District") required one interpretive step the doc doesn't spell out: Alma Vale's ballot columns are spectrum-labeled (`Left_Left`, etc.), but Section 3 establishes the actual fielded *party* per spectrum varies by constituency — so votes are mapped constituency → actual party (via `df_party_participation.csv`) before being pooled into district totals, rather than pooling raw spectrum totals nationally (which would incorrectly merge different parties from different constituencies under one spectrum label). **Superseded 2026-08-04 — see below**: this per-constituency party-mapping approach was replaced by a spectrum-first tally with NRD/LRP explicitly pooled under one label, and "District" itself was clarified to mean each of the 1,779 individual units, not a District *name* grouping.

**Resolved 2026-08-11**: the Proportional gate-exclusion edge case flagged above was patched, user-directed — the 15% quorum rule (a list below gate gets zero seats) should always leave the full 45 seats allocated among the remaining qualifying lists, not just in the common case:

- `js/data/proportional.js`'s `computeProportionalAllocation()` now computes the Stage 1 national quota as `(sum of qualifying lists' votes) ÷ totalSeats`, instead of `Valid Votes ÷ totalSeats` (which included gated-out lists' votes in the denominator with no list left to claim the seats they implied). `Percent` and the 15% gate check itself are unaffected — both still read against the full `Valid Votes`, per Section 4 steps 2–3; only the quota that Stage 1's floor+largest-remainder round uses was narrowed to qualifying votes.
- This is a standard property of Hare quota + largest remainder: when the quota's denominator exactly equals the pool of votes being distributed, the floor+remainder round always sums to exactly `totalSeats` — so a gated-out list, however large its vote share, can no longer cause the total to fall short of 45.
- `js/data/test/proportional.test.mjs`'s gated-list edge case now asserts the total is exactly 45 (previously only asserted `≤ 45`, with a NOTE explaining the possible shortfall — that NOTE and the looser assertion are gone).

Resolved 2026-08-03: General Direct's referendum "no path to Authority/County" finding — turned out not to be a gap. General Direct is a confirmed **functional constituency** (Section 4): it never renders on any choropleth map, General Election or Referendum, so it never needed a join to Authority/County in the first place — it's shown as its own flat table on both pages.

Resolved 2026-08-02: Home Districts/General Direct `basis` (→ `Constituency`), the `Local Representative` derivation scope (one-off, row now entirely blank), the General Direct grouping-key swap (regrouped by `Constituency`), the `Competing` column (removed — full 45-candidate slate), the `Zone`/`Authority` join-key mismatch (documented in Section 1), and the split-district drill-down behavior (Section 1 — filter by District + active Constituency).

**Resolved 2026-08-04**: `GeneralProportional`'s `Right`-column quirk (line 270 above) was resolved by fixing the data instead of special-casing the display. `df_results_general_proportional.csv`'s `Right` header column was renamed to `GCCA`, and `election_meta.json`'s `GeneralProportional.lists[]` now reads `{ "id": "Right", "parties": ["GCCA"] }` — the Right list's one member party is the real `GCCA` entry in `parties[]`, same as every other list, no more literal-abbreviation special case. (Section 4's sample CSV columns and worked example above are already updated to match; RA still doesn't contest General Proportional, only GCCA.) The General Proportional results page (`election-general-proportional.js`) was also reworked post-launch, beyond what Section 4 originally specified:
- Stage 1/Stage 2 D3 bar charts replaced with tables: one combined "Seats by list" table (List/Votes/Valid Proportion/Qualified/Seats), where a multi-party list (Left) expands to show its within-list party breakdown — same data the charts showed, no chart library involved on this page anymore.
- The stat-tile row was trimmed to Total votes/Valid votes/Turnout/Quota (Quota rounded up via `Math.ceil`, not the exact decimal); the 15% Gate figure moved into the list table's own `Qualified` column ("No — below gate") instead of its own tile. **Superseded 2026-08-04 — see below**: the fourth tile is now "Quorum" (the 15% Gate figure itself, back as its own tile, `Math.round` not `Math.ceil`) and the underlying gate/quota math it reflects changed too.
- The reporting-sectors card grid was replaced by a table (rows = sectors, columns = Status/Electorate/Turnout/Turnout %/one column per contesting party/Spoil/one vote-share % column per list), each row expandable into its own `Sub_Constituency` breakdown when a sector's `Constituency` actually has more than one reporting row (grouped the same way Home Districts/General Direct group sub-rows) — exercised for real once `Swift` started reporting as 6 separate rows instead of 1.
- `js/data/results.js`'s `getGeneralProportionalResult()` sectors are now grouped by `Constituency` (previously one entry per raw row) and carry `statusSummary`/gated `partyVotes`/gated `spoil`, plus a `subRows` array when a sector has genuine sub-divisions.
- Fixed two overview-page (`election-overview.js`) regressions surfaced by that data-shape change: (1) the "is General Proportional fully declared" check was reading a `sector.status` field that no longer exists post-regrouping (silently always false — showed "0 declared" even at 45/45), fixed to use `isFullyDeclared(sector.statusSummary)`; (2) the per-party seat tally (spectrum totals, seats bar, breakdown table) only ever iterated `electionMeta.parties[]`, so any list-party abbreviation without its own `parties[]` entry silently dropped out of every party-keyed view even though the seat-type total still counted it — fixed via a `buildDisplayParties()` helper (now largely dormant since the `Right`→`GCCA` fix above means every General Proportional party already has a real `parties[]` entry, but left in as a defensive fallback rather than ripped out).

**Resolved 2026-08-04**: General Direct's results page (`election-general-direct.js`) was substantially reworked post-launch, beyond what Section 4 originally specified — it now shows real vote numbers instead of just status/leading-party:
- Dropped the FEATURE_SPEC.md-quoting banner, the "10 seats · one per Constituency..." subtitle, the Seats/Decided stat tiles, and the "This seat's total aggregates N Sub_Constituency reporting rows" caption on expanded rows.
- Table columns, in order: Constituency, Electorate, Vote, Turnout (%), Left/MR/Right **Final**, Left/MR/Right **1st**, Spoil, Status. "Status" merges the old separate Status/Result columns (status badge while reporting, winning-party pill once every underlying row is Declared). Vote columns are labeled by **spectrum** (Left/MR/Right, `election_meta.json`'s `spectrums[]` order) rather than by the specific party fielded in each — unlike the Status/Result pill, which still names the actual party.
- "Final" is the renamed `2nd` column and always holds the seat's settled per-spectrum number: `round2`'s value when a 2nd round actually ran (Supplementary Vote elimination/redistribution), or a straight copy of `round1` when a spectrum won outright in round 1 (so a seat decided in round 1 never shows a fabricated zero in Final). Only Final ever gets the winning spectrum's bold treatment — 1st is a pure reference column now, never bolded.
- Every not-applicable vote cell (an eliminated spectrum's Final value; `Local Representative`'s columns before it had real numbers, see below) renders `0`, not `—`; `—` is reserved for genuinely *unknown* values (Turnout % with no denominator yet, or a real seat's Vote before it reaches Counting).
- Constituency names are plain text now, not links to `election-seat.html` — the per-seat detail sub-page duplicated what this table already shows directly. `Local Representative` is the one exception: it still links to its own sub-page (`election-local-representative.html`), which shows genuinely different data (district-by-district breakdown).
- `Local Representative` is fed through the same table columns as every other seat instead of rendering placeholder blanks: `js/data/localRepresentative.js`'s `deriveLocalRepresentative()` gained a `totalDistrictsNationwide` field (sum of every council's district count), and `js/data/results.js`'s `getLocalRepresentativeSeat()` uses it to treat the derived seat as its own mini-election where each of the 1,779 Districts nationwide is "one voter" — `Electorate`/`Vote` both equal that total (Turnout comes out to a clean 100%), and each spectrum's "vote" is the count of Districts that spectrum's pooled display party actually won (`round2`/`Spoil` stay null/0 — FPTP derivation, no Supplementary Vote transfer round). This is a display convenience for the shared table only; the real per-District Declared/undeclared split is still exclusively on the seat's own sub-page.
- `election-local-representative.js`'s subtitle ("General Direct · derived seat — not directly voted") and its FEATURE_SPEC.md-quoting derivation-rule banner paragraph were dropped for the same reason as the caption above — the stat tiles (Districts considered / Alma Vale precincts considered / Precincts skipped) and both data tables are untouched.

**Resolved 2026-08-04**: Section 1's "Load limiting" rule ("clicking a unit loads only its children plus the children of neighboring units... computed from shared polygon borders") is not what either live map component actually does, and hasn't been for `electionMap.js` since its own earlier rewrite. Both `js/map/electionMap.js` and (as of this date) `js/map/referendumMap.js` instead render every top-level unit always and expand exactly one path at a time in place — clicking a unit reveals its children while every sibling stays at its own already-rendered level. This satisfies the same underlying constraint (well under 10,000 rendered shapes) without ever computing geometric adjacency, and turned out simpler to reason about than the neighbor-loading model, which is why `referendumMap.js` was rewritten off it. `getUnitAndNeighborIds`/`getAdjacency` (`js/data/shapes.js`) remain in the data layer and stay covered by tests — they're just not called by either map anymore. See `election-site/BUILD_NOTES.md`'s "Map component contract" section and its 2026-08-04 Post-launch fixes entry for the implementation-level detail.

**Resolved 2026-08-04**: the Referendum page's "Overall result" section, which summed AlmaVale's and GeneralDirect's Yes/No totals into one combined bar, was removed — nothing in this doc ever specified combining them, and doing so mixed two different electorates voting on the same question into one number. Each scoped seat type now gets its own result presentation instead (`js/pages/referendum.js`'s `renderSectionSummaries()`); see `election-site/BUILD_NOTES.md` for the full writeup of this and the rest of that day's Referendum-page work (map rewrite per the item above, tooltip/table redesigns, a Section-2 gating bug fix in the precinct tooltip).

**Resolved 2026-08-04**: four corrections to `Local Representative`'s derivation (Section 4), all user-directed after reviewing the live data against earlier (incorrect) builds of this rule — recorded here since two of them directly contradict Open Items bullets above that were written before the shapefile data was regenerated:

- **What "each District" means, precisely**: `data/shapes/df_districts.csv` has ~1,779 rows but only ~37–38 distinct District *names* (e.g. `"Alington City"` groups 87 rows spread across 2 constituencies — the count drifts slightly across shapefile regenerations, don't hardcode it). "Sum votes per party within each District; whichever party has the plurality wins that District" (Section 4, step 2) means each of the **1,779 individual rows** — every `(District, District_Ward)` pair is its own independently-contested unit worth one vote toward the seat — not the ~37 broader District names. Section 1's "12 districts straddle two constituencies" is about the *name*-level grouping and is unaffected by this; a single `(District, District_Ward)` row always belongs to exactly one Constituency. The UI now calls the name-level grouping a "council" to keep the two concepts visually distinct (`election-local-representative.js`'s "Vote breakdown by council" table, `js/data/localRepresentative.js`'s `councils` object) — a council has no vote of its own, it's purely a display rollup of however many District units it contains.
- **NRD and LRP are pooled under one "LRP" label for this derivation specifically.** Section 3 establishes NRD and LRP are genuinely separate, independently-competing parties everywhere else (General Proportional runs them against each other in the Section 4 worked example) — but `df_party_participation.csv`'s own `GeneralDirect`/`Local Representative` participation row sets `Left_Party = LRP` (unlike every other `GeneralDirect` row, which uses `NRD`), existing specifically to supply a single display label for the Left spectrum's nationally-pooled total on this one derived seat. Since a constituency only ever fields one of NRD/LRP for its Left seat (SupplementaryVote seats field exactly one party per spectrum, Section 3), tallying by spectrum first and mapping to a display label only at the end (`js/data/localRepresentative.js`'s `tallyFirstPreferenceSpectrumVotes`/`buildSpectrumDisplayLabels`/`relabelSpectrumVotes`) achieves this without ever needing the old per-constituency party lookup — `"NRD"` never appears as a label anywhere in this derivation's output, only `LRP`/`GRF`/`GCCA`.
- **A District/Ward unit only counts once every one of its precincts is Declared** — not from its first Declared precinct alone. A unit with, say, 4 of 5 precincts Declared can still have its apparent plurality flip once the last one reports, so showing it as decided on partial data would be misleading. Real impact on the live data: of 1,779 units, 434 are typically in exactly this partially-Declared state at any given time and must show as undeclared, not decided.
- **The fragment-to-precinct join is now an exact `(District, District_Ward)` label match**, not the spatial (point-in-polygon) join the "District second-layer geometry" Open Items bullet above describes — `df_districts.csv` was regenerated to carry its own `District_Ward` column matching `df_polygon.csv`'s, resolving all 20,850 precincts with zero misses and zero duplicate keys (the old `"Alma Causeway"` / `District_ID "1"` duplicate that originally justified the spatial workaround is gone from the current data too). `js/data/shapes.js`'s `getFragmentAssignments()` was rewritten accordingly — simpler and exact instead of an approximation.

**Resolved 2026-08-04**: `General Proportional`'s `Local Representative` reporting sector — previously entirely blank in `df_results_general_proportional.csv` by design, same as its General Direct row, meaning General Proportional could never actually reach `isFinal` (one of its 10 sectors could never Declare) — is now populated, user-directed:

- **Same underlying electorate as the General Direct `Local Representative` seat, since it's the same voters.** The sector's votes are derived from the identical Alma Vale District-level tally (`js/data/localRepresentative.js`'s `deriveLocalRepresentative()`) rather than any of its own ballot data — `Electorate` and `Turnout` are both pinned to `totalDistrictsNationwide` (each of the ~1,779 Districts counts as "one voter," same convention the General Direct table already uses for this seat), and `Spoil` is always 0 (FPTP plurality-of-Districts, no spoiled-ballot concept at that level).
- **NRD and LRP are kept as separate parties here, unlike the General Direct derivation.** That seat's derivation deliberately pools every Left-spectrum vote nationwide under one combined `LRP` display label (see the "NRD and LRP are pooled..." bullet above) — General Proportional runs NRD and LRP as genuinely separate competing lists everywhere else, so pooling them for this sector would misrepresent both parties' national vote totals. `deriveLocalRepresentative()` gained an optional `partiesForRow` parameter: when supplied, each District's plurality winner is decided by actual party (resolved per precinct via its own constituency's `AlmaVale` participation row) instead of the pooled spectrum label; omitted, existing General Direct callers are unaffected. `js/data/results.js`'s `buildLocalRepresentativeProportionalSector()` calls it with this resolver and shapes the result to match the other 9 sectors (`statusSummary`/`electorate`/`turnout`/`partyVotes`/`spoil`), except `subRowCount` is pinned to 1 — an expandable per-District (let alone per-precinct) breakdown on this table would be unusable; that granularity already lives on the Alma Vale / Local Representative sub-pages.
- **A party's "votes" for this sector are Districts won, not raw ballots** — same non-literal convention the General Direct vote table already uses for this seat (each spectrum's "1st preference" cell there is Districts won by that spectrum's pooled party, not a real ballot count); here it's Districts won by each actual party (NRD/LRP separately) instead.
- The sector's own `statusSummary` (feeding its status badge and the page's declared-sector count) is synthesized from District completion counts, not re-derived from the ~20,850 underlying precinct rows — each of the `totalDistrictsNationwide` Districts is weighted 1 (matching `Electorate`), Declared once fully considered (every one of its precincts Declared), Not received otherwise (the derivation only tracks "fully Declared or not" per District, no intermediate Verifying/Counting state to report).
- The provisional banner paragraph ("Provisional. Seats are allocated nationally...") and the page-header's "(N guaranteed so far, M undetermined)" suffix were both dropped from `election-general-proportional.js`, same instinct as the banner/caption removals logged elsewhere in this section.

**Resolved 2026-08-04**: the General Proportional results page's 4th stat tile was renamed **Quota → Quorum** and its value — and the guaranteed-minimum provisional method's actual qualifying gate — changed from a flat `15% × Electorate` figure to a tighter, progressively-refined bound, user-directed after noticing the displayed Quorum figure didn't match which lists the `Qualified` column actually credited:

- **Three safe substitutes for "final Valid Votes," tightening as more is known per Section 2's status pipeline, applied per reporting row and summed nationally** (`js/data/results.js`'s `computeSafeVoteBound()`): a Not-received/Verifying row only has its `Electorate` known (`Turnout ≤ Electorate` always holds, so it's a safe — if loose — upper bound); a Counting row's `Turnout` is visible and fixed (`Valid = Turnout − Spoil ≤ Turnout`, a tighter safe bound); a Declared row's own Valid Votes contribution is exact, no substitute needed. Because every row's status only ever advances forward in this sequence over time, the summed national bound only ever tightens (or holds), never loosens.
- `js/data/proportional.js`'s `computeGuaranteedMinimumAllocation()` gained an optional `voteBound` input (defaulting to `electorate` when omitted, so its existing monotonicity/never-overstates guarantees and their tests are untouched) — the gate (`thresholdPct% × voteBound`) and quota (`voteBound ÷ totalSeats`) are computed against this instead of always `electorate`. `getGeneralProportionalResult()` builds it from the 9 real reporting rows plus the derived `Local Representative` sector's own bound (always exactly `totalDistrictsNationwide` — a District's `Electorate` and eventual vote contribution are both exactly 1, so there's no intermediate tier for it to pass through).
- The Quorum tile (`election-general-proportional.js`) now reads `result.gateVotes` directly — the same figure the `Qualified` column's gate check itself uses in both the provisional and final allocation methods, `Math.round` rather than `Math.ceil` — so the two can no longer visibly disagree.

**Resolved 2026-08-04**: Alma Vale/Home Districts/General Direct (`method: SupplementaryVote`) originally only ever showed a seat's winner once literally 100% of its rows were Declared, per Section 2's aggregation rule read at face value — in practice a seat sitting at 99%+ declared with a decisive margin still displayed a bare status badge instead of its winner, since one outstanding Verifying/Not-received row (however small its electorate) was enough to block a literal-100% gate. User-directed fix: declare a winner once it's mathematically certain, not just once literally complete — see Section 4's new paragraph above for the exact rule. One correction made along the way, worth recording since it was the originally-requested wording: **"a runoff is guaranteed once the gap between the current 1st and 2nd place exceeds the undecided pool" is not rigorously correct.** Counterexample: Left=100, Right=85, MR=16, undecided=5 — `gap(1st,2nd) = 15 > 5` passes that test, but the leader's best case (all 5 undecided votes) reaches 105, which still beats half of the eventual 206-vote total, so an outright majority is still reachable and a runoff is NOT actually guaranteed. The rigorous complement of the majority test — `(2nd + 3rd) − 1st ≥ undecided`, i.e. even the leader's absolute best case can't clear 50% — was used instead; verified against this and other cases in `js/data/test/supplementaryVote.test.mjs`. This also touched: the seat-type list tables (Alma Vale/General Direct's "Final" vote columns now read "Undecided" rather than a possibly-premature round-2 number until the runoff pair itself is certain); the home page's headline seats-won tally; individual seat-detail pages; and the election map's tooltips (Constituency/County-District levels read "Pending" for the same reason, plus a new "In progress, {Round Status}, {Winner Decided}" status line — Round Status one of "Runoff Uncertain"/"No Runoff Needed"/"Runoff Needed"/"Runoff In Progress", Winner Decided one of "Winner Undecided"/"Winner Decided" — and the Precinct-level tooltip's own round-2 figures are now gated on the parent Constituency's certainty too, since a single precinct's locally-lowest spectrum can differ from whichever spectrum the Constituency-wide runoff is actually eliminating). See `election-site/BUILD_NOTES.md` for the full per-file implementation writeup.

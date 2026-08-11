/**
 * meta.js — election_meta.json / referendum_meta.json / df_party_participation.csv
 * loading and lookups (FEATURE_SPEC.md Sections 3, 4, 5, 8).
 *
 * These three files are the "manifest" layer: seat-type rosters, which
 * files back them (`results_file`), the spectrum/party roster, and list
 * coalitions for General Proportional. Per Section 4's closing note, file
 * names are never hardcoded elsewhere in this data layer — every loader in
 * results.js / referendum.js resolves its CSV path through this module.
 */

import { fetchJSON, fetchCSV } from './csv.js';
import { dataPath } from './config.js';

let _electionMetaPromise = null;
let _referendumMetaPromise = null;
let _partyParticipationPromise = null;

/** Loads meta/election_meta.json (memoized). */
export function loadElectionMeta() {
  if (!_electionMetaPromise) _electionMetaPromise = fetchJSON(dataPath('meta/election_meta.json'));
  return _electionMetaPromise;
}

/** Loads referendum/referendum_meta.json (memoized). */
export function loadReferendumMeta() {
  if (!_referendumMetaPromise) _referendumMetaPromise = fetchJSON(dataPath('referendum/referendum_meta.json'));
  return _referendumMetaPromise;
}

/**
 * Loads meta/df_party_participation.csv (memoized) — the authoritative
 * seat roster for Alma Vale / Home Districts / General Direct (55 rows:
 * Seat_Type + Constituency + Sub_Constituency), and the source of which
 * specific party is "the Left/Right/MR party" for each seat (Section 3).
 * @returns {Promise<Array<Object>>}
 */
export function loadPartyParticipation() {
  if (!_partyParticipationPromise) _partyParticipationPromise = fetchCSV(dataPath('meta/df_party_participation.csv'));
  return _partyParticipationPromise;
}

/** Drops the memoized meta promises so the next load*() call re-fetches. Exposed for the "Reload results" flow (data.js's refreshAllData()) / tests. */
export function _resetMetaCache() {
  _electionMetaPromise = null;
  _referendumMetaPromise = null;
  _partyParticipationPromise = null;
}

/**
 * Find a seat type entry by its `id` (e.g. "AlmaVale") or `name` (e.g. "Alma Vale").
 * @param {Object} electionMeta result of loadElectionMeta()
 * @param {string} idOrName
 * @returns {Object|null}
 */
export function findSeatType(electionMeta, idOrName) {
  if (!electionMeta || !Array.isArray(electionMeta.seat_types)) return null;
  return electionMeta.seat_types.find((st) => st.id === idOrName || st.name === idOrName) || null;
}

/**
 * Resolve a seat type's `results_file` (relative to data/) to a fetchable URL.
 * @param {{results_file:string}} seatType
 * @returns {string}
 */
export function seatTypeResultsUrl(seatType) {
  if (!seatType || !seatType.results_file) {
    throw new Error('data layer: seat type has no results_file');
  }
  return dataPath(seatType.results_file);
}

/**
 * Look up a party by abbreviation.
 * @param {Object} electionMeta
 * @param {string} abbreviation
 * @returns {{abbreviation:string, name:string, spectrum:string}|null}
 */
export function findParty(electionMeta, abbreviation) {
  if (!electionMeta || !Array.isArray(electionMeta.parties)) return null;
  return electionMeta.parties.find((p) => p.abbreviation === abbreviation) || null;
}

/**
 * Look up a spectrum by id.
 * @param {Object} electionMeta
 * @param {string} spectrumId
 * @returns {{id:string, name:string, color:string}|null}
 */
export function findSpectrum(electionMeta, spectrumId) {
  if (!electionMeta || !Array.isArray(electionMeta.spectrums)) return null;
  return electionMeta.spectrums.find((s) => s.id === spectrumId) || null;
}

/**
 * Flatten `lists[]` (from the GeneralProportional seat type entry) into a
 * simple party-abbreviation -> list-id map. FEATURE_SPEC.md Section 4 notes
 * `lists[]` is a strict superset of the old flat `participating_parties`
 * array — flattening it recovers that.
 * @param {Array<{id:string, parties:string[]}>} lists
 * @returns {Map<string,string>} party abbreviation -> list id
 */
export function flattenLists(lists) {
  const map = new Map();
  for (const list of lists || []) {
    for (const party of list.parties || []) map.set(party, list.id);
  }
  return map;
}

/**
 * Find a df_party_participation.csv row for a given seat.
 * @param {Array<Object>} participationRows result of loadPartyParticipation()
 * @param {string} seatTypeId e.g. "AlmaVale" | "HomeDistricts" | "GeneralDirect"
 * @param {string} constituency
 * @param {string} [subConstituency] Defaults to `constituency` (matches the
 *   convention that flat seats have Constituency === Sub_Constituency).
 * @returns {Object|null}
 */
export function findParticipation(participationRows, seatTypeId, constituency, subConstituency) {
  const sub = subConstituency == null ? constituency : subConstituency;
  return (
    participationRows.find(
      (row) => row.Seat_Type === seatTypeId && row.Constituency === constituency && row.Sub_Constituency === sub
    ) || null
  );
}

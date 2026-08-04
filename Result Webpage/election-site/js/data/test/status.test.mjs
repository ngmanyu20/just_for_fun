/**
 * Tests for status.js's time-gating (FEATURE_SPEC.md Section 2).
 * Run with: node election-site/js/data/test/status.test.mjs
 */
import { STATUS, computeStatus, percentDeclared, summarizeStatus, toNumber, parseTimestamp } from '../status.js';

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const NOW = new Date('2026-08-03T12:00:00Z');
const PAST = '2026-08-01T00:00:00Z';
const FUTURE = '2026-08-10T00:00:00Z';

check(computeStatus({}, NOW) === STATUS.NOT_RECEIVED, 'all-blank row -> Not received');
check(computeStatus({ received_at: '' }, NOW) === STATUS.NOT_RECEIVED, 'empty-string received_at -> Not received');
check(computeStatus({ received_at: FUTURE }, NOW) === STATUS.NOT_RECEIVED, 'future received_at -> Not received');
check(computeStatus({ received_at: PAST }, NOW) === STATUS.VERIFYING, 'past received_at only -> Verifying');
check(computeStatus({ received_at: PAST, verified_at: PAST }, NOW) === STATUS.COUNTING, 'past received+verified -> Counting');
check(
  computeStatus({ received_at: PAST, verified_at: PAST, declared_at: PAST }, NOW) === STATUS.DECLARED,
  'past received+verified+declared -> Declared'
);
check(
  computeStatus({ received_at: PAST, verified_at: PAST, declared_at: FUTURE }, NOW) === STATUS.COUNTING,
  'future declared_at with past verified_at -> Counting (not yet Declared)'
);
check(computeStatus({ declared_at: 'not-a-date' }, NOW) === STATUS.NOT_RECEIVED, 'unparseable timestamp treated as null, no throw');
check(computeStatus(null, NOW) === STATUS.NOT_RECEIVED, 'null row -> Not received, no throw');

check(toNumber('') === 0, 'toNumber("") is 0');
check(toNumber(undefined) === 0, 'toNumber(undefined) is 0');
check(toNumber('1234') === 1234, 'toNumber parses digits');
check(toNumber('abc') === 0, 'toNumber non-numeric -> 0, not NaN');
check(parseTimestamp('') === null, 'parseTimestamp("") is null');

// Electorate-weighted percentDeclared, not a plain row count (Section 2).
{
  const rows = [
    { Electorate: '100', declared_at: PAST, verified_at: PAST, received_at: PAST }, // Declared, small
    { Electorate: '900', declared_at: FUTURE, verified_at: PAST, received_at: PAST }, // Counting, large
  ];
  const pct = percentDeclared(rows, { now: NOW });
  // 1 of 2 rows declared by count (50%), but only 100 of 1000 electorate (10%).
  check(Math.abs(pct - 10) < 1e-9, 'percentDeclared is electorate-weighted, not row-count-based', pct);
}

check(percentDeclared([], { now: NOW }) === 0, 'percentDeclared on empty array is 0, no divide-by-zero');
check(
  percentDeclared([{ Electorate: '0', declared_at: PAST, verified_at: PAST, received_at: PAST }], { now: NOW }) === 0,
  'percentDeclared with all-zero electorate is 0, no divide-by-zero'
);

{
  const summary = summarizeStatus(
    [
      { Electorate: '100', declared_at: PAST, verified_at: PAST, received_at: PAST },
      { Electorate: '100', verified_at: PAST, received_at: PAST },
      { Electorate: '100', received_at: PAST },
      { Electorate: '100' },
    ],
    { now: NOW }
  );
  check(summary.totalRows === 4, 'summarizeStatus counts all rows');
  check(summary.byStatus[STATUS.DECLARED].count === 1, 'summarizeStatus buckets Declared count correctly');
  check(Math.abs(summary.percentDeclared - 25) < 1e-9, 'summarizeStatus percentDeclared matches percentDeclared()');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

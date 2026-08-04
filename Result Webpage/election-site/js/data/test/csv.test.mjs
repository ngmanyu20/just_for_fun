/**
 * Sanity tests for csv.js's parseCSV() against the exact shapes this
 * dataset uses: quoted geometry fields with embedded commas, entirely
 * blank rows (Local Representative), short/empty files.
 *
 * Run with: node election-site/js/data/test/csv.test.mjs
 */
import { parseCSV } from '../csv.js';

let failures = 0;
function check(cond, label) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Quoted field with an embedded comma (geometry-like).
{
  const text = 'Shape_ID,geometry,Area\nA01_001,"POLYGON ((1 2, 3 4, 5 6))",0.57\n';
  const rows = parseCSV(text);
  check(rows.length === 1, 'one data row parsed');
  check(rows[0].geometry === 'POLYGON ((1 2, 3 4, 5 6))', 'quoted comma-bearing field preserved');
  check(rows[0].Area === '0.57', 'plain field after quoted field parsed correctly');
}

// Entirely blank row (Local Representative style) round-trips as empty strings, not dropped.
{
  const text = 'Constituency,Sub_Constituency,Electorate\nSwift,Swift,70906\n,,\n';
  const rows = parseCSV(text);
  check(rows.length === 2, 'blank row is not dropped');
  check(rows[1].Constituency === '' && rows[1].Sub_Constituency === '' && rows[1].Electorate === '', 'blank row fields are empty strings');
}

// Header-only file -> [].
{
  const rows = parseCSV('Shape_ID,Electorate,Turnout\n');
  check(Array.isArray(rows) && rows.length === 0, 'header-only file returns []');
}

// Completely empty file -> [].
{
  const rows = parseCSV('');
  check(Array.isArray(rows) && rows.length === 0, 'empty file returns []');
}

// null/undefined input never throws.
{
  const rows = parseCSV(undefined);
  check(Array.isArray(rows) && rows.length === 0, 'undefined input returns [] without throwing');
}

// CRLF line endings.
{
  const text = 'A,B\r\n1,2\r\n3,4\r\n';
  const rows = parseCSV(text);
  check(rows.length === 2 && rows[1].A === '3' && rows[1].B === '4', 'CRLF line endings handled');
}

// Escaped quotes inside a quoted field.
{
  const text = 'Name,Note\n"O""Brien","says ""hi"""\n';
  const rows = parseCSV(text);
  check(rows[0].Name === 'O"Brien' && rows[0].Note === 'says "hi"', 'escaped quotes inside quoted field');
}

// UTF-8 BOM at start of file is stripped from the first header.
{
  const text = '﻿Shape_ID,Electorate\nA01_001,1000\n';
  const rows = parseCSV(text);
  check(rows[0].Shape_ID === 'A01_001', 'BOM stripped, first header key clean');
}

// Short row (fewer fields than header) fills missing trailing columns with ''.
{
  const text = 'A,B,C\n1,2\n';
  const rows = parseCSV(text);
  check(rows[0].A === '1' && rows[0].B === '2' && rows[0].C === '', 'short row pads missing trailing fields');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

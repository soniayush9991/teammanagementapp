import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeCell, toCsv } from '../../src/lib/csv.ts';

test('commas, quotes and newlines are quoted per RFC 4180', () => {
  assert.equal(escapeCell('plain'), 'plain');
  assert.equal(escapeCell('a,b'), '"a,b"');
  assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCell('line1\nline2'), '"line1\nline2"');
});

test('formula triggers are neutralised against CSV injection', () => {
  // A task titled like this must not execute when opened in a spreadsheet.
  assert.equal(escapeCell('=1+1'), "'=1+1");
  // Neutralised AND quoted, because the value also contains quotes.
  assert.equal(escapeCell('+HYPERLINK("http://evil")'), '"\'+HYPERLINK(""http://evil"")"');
  assert.equal(escapeCell('-2+3'), "'-2+3");
  assert.equal(escapeCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
});

test('empty values render as empty cells, not "null"', () => {
  assert.equal(escapeCell(null), '');
  assert.equal(escapeCell(undefined), '');
  assert.equal(escapeCell(0), '0');
});

test('a full document carries a BOM and CRLF line endings', () => {
  const csv = toCsv([{ name: 'Ada', hours: 8 }], [
    { header: 'Name', value: (row) => row.name },
    { header: 'Hours', value: (row) => row.hours },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), 'expected a UTF-8 BOM for Excel');
  assert.equal(csv, '\uFEFFName,Hours\r\nAda,8\r\n');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTablePdf } from '../../src/lib/pdf.ts';

const columns = [
  { header: 'Employee', width: 120 },
  { header: 'Planned', width: 60 },
];

test('renders a structurally valid single-page PDF', () => {
  const pdf = renderTablePdf({
    title: 'Employee workload report',
    subtitle: 'Week 2026-W39',
    columns,
    rows: [['Ada Lovelace', '32'], ['Bob Ross', '12']],
  });
  const text = pdf.toString('latin1');

  assert.ok(text.startsWith('%PDF-1.4'), 'missing PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'missing EOF marker');
  assert.ok(text.includes('/Type /Catalog'));
  assert.ok(text.includes('/Count 1'), 'expected exactly one page');
  assert.ok(text.includes('(Employee workload report) Tj'));
  assert.ok(text.includes('(Ada Lovelace) Tj'));
  assert.ok(/startxref\n\d+/.test(text), 'missing startxref offset');
});

test('long tables paginate', () => {
  const rows = Array.from({ length: 120 }, (_, index) => [`Person ${index}`, String(index)]);
  const text = renderTablePdf({ title: 'Big report', columns, rows }).toString('latin1');
  const pageCount = Number(/\/Count (\d+)/.exec(text)?.[1] ?? 0);
  assert.ok(pageCount > 1, `expected multiple pages, got ${pageCount}`);
  assert.ok(text.includes(`Page 1 of ${pageCount}`));
});

test('an empty report still produces a readable page', () => {
  const text = renderTablePdf({ title: 'Nothing overdue', columns, rows: [] }).toString('latin1');
  assert.ok(text.includes('/Count 1'));
  assert.ok(text.includes('(Nothing overdue) Tj'));
});

test('parentheses and backslashes in data cannot break the content stream', () => {
  const text = renderTablePdf({
    title: 'Escaping',
    columns,
    rows: [['Fix (urgent) C:\\path', '4']],
  }).toString('latin1');
  assert.ok(text.includes('Fix \\(urgent\\) C:\\\\path'));
});

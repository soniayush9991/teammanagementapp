/**
 * Minimal RFC 4180 CSV writer.
 *
 * The leading-apostrophe guard is deliberate: a cell starting with =, +, -
 * or @ is executed as a formula when the export is opened in Excel or
 * Sheets, which turns an innocent task title into a CSV injection. Prefixing
 * a quote neutralises it while staying readable.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);

  if (FORMULA_TRIGGERS.some((trigger) => text.startsWith(trigger))) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((column) => escapeCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(column.value(row))).join(','));
  }
  // Excel needs CRLF and a BOM to read UTF-8 correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

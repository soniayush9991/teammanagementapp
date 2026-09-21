/**
 * A tiny, dependency-free PDF writer for tabular reports.
 *
 * Reports are simple (title, generated-at line, a table) so emitting the PDF
 * directly avoids pulling a rendering engine and a headless browser into the
 * deployment. It writes a single-page-per-chunk document using the standard
 * Helvetica font, which every PDF reader has built in.
 */

interface PdfTableOptions {
  title: string;
  subtitle?: string;
  columns: { header: string; width: number }[];
  rows: string[][];
}

const PAGE_WIDTH = 842; // A4 landscape, points
const PAGE_HEIGHT = 595;
const MARGIN = 36;
const LINE_HEIGHT = 14;
const ROWS_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2 - 60) / LINE_HEIGHT);

function escapeText(value: string): string {
  // Backslash and parentheses are PDF string delimiters.
  return value.replace(/([\\()])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}

function truncate(value: string, width: number): string {
  // Helvetica averages ~0.5em per glyph at the sizes used here.
  const maxChars = Math.max(3, Math.floor(width / 5));
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function buildPageContent(options: PdfTableOptions, rows: string[][], pageNumber: number, pageCount: number): string {
  const parts: string[] = ['BT'];
  let y = PAGE_HEIGHT - MARGIN;

  parts.push(`/F2 16 Tf 1 0 0 1 ${MARGIN} ${y} Tm (${escapeText(options.title)}) Tj`);
  y -= 20;
  if (options.subtitle) {
    parts.push(`/F1 9 Tf 1 0 0 1 ${MARGIN} ${y} Tm (${escapeText(options.subtitle)}) Tj`);
    y -= 18;
  }

  // Header row.
  let x = MARGIN;
  parts.push('/F2 9 Tf');
  for (const column of options.columns) {
    parts.push(`1 0 0 1 ${x} ${y} Tm (${escapeText(truncate(column.header, column.width))}) Tj`);
    x += column.width;
  }
  y -= LINE_HEIGHT;

  parts.push('/F1 9 Tf');
  for (const row of rows) {
    x = MARGIN;
    for (const [index, column] of options.columns.entries()) {
      const cell = row[index] ?? '';
      parts.push(`1 0 0 1 ${x} ${y} Tm (${escapeText(truncate(cell, column.width))}) Tj`);
      x += column.width;
    }
    y -= LINE_HEIGHT;
  }

  parts.push(
    `/F1 8 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 12} Tm (Page ${pageNumber} of ${pageCount}) Tj`,
  );
  parts.push('ET');
  return parts.join('\n');
}

/** Builds the PDF byte stream. Returns a Buffer ready to stream to a client. */
export function renderTablePdf(options: PdfTableOptions): Buffer {
  const pages: string[][][] = [];
  for (let index = 0; index < Math.max(1, options.rows.length); index += ROWS_PER_PAGE) {
    pages.push(options.rows.slice(index, index + ROWS_PER_PAGE));
  }

  const objects: string[] = [];
  const pageObjectIds: number[] = [];

  // 1: catalog, 2: pages, 3: Helvetica, 4: Helvetica-Bold, then per page a
  // page object and a content stream.
  const firstPageId = 5;
  pages.forEach((_rows, index) => pageObjectIds.push(firstPageId + index * 2));

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  pages.forEach((rows, index) => {
    const pageId = firstPageId + index * 2;
    const contentId = pageId + 1;
    const content = buildPageContent(options, rows, index + 1, pages.length);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id];
    if (!body) continue;
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const maxId = objects.length - 1;
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets[id] ?? 0;
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

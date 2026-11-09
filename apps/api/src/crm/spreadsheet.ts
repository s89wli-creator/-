import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../common/errors';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP container

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula: use cached result, never evaluate
    if ('error' in v) return '';
  }
  return String(v);
}

/** Makes headers unique and non-empty ("الهاتف", "الهاتف (2)", "عمود 3"). */
function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim().replace(/\s+/g, ' ') || `عمود ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function toRecords(matrix: string[][], maxRows: number): ParsedSheet {
  const headerRow = matrix.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerRow === -1) throw badRequest('EMPTY_FILE', 'The file has no data');
  const headers = uniqueHeaders(matrix[headerRow]!);
  const rows: Record<string, string>[] = [];
  for (const r of matrix.slice(headerRow + 1)) {
    if (!r.some((c) => c.trim() !== '')) continue;
    if (rows.length >= maxRows) throw badRequest('TOO_MANY_ROWS', `The file has more than ${maxRows} rows`, { maxRows });
    rows.push(Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim().slice(0, 2000)])));
  }
  if (!rows.length) throw badRequest('EMPTY_FILE', 'The file has no data rows');
  return { headers, rows };
}

/** Parses .xlsx (first worksheet) or .csv (UTF-8, auto-detects , ; and tab). Type is decided by content, not extension. */
export async function parseSpreadsheet(buffer: Buffer, filename: string, maxRows: number): Promise<ParsedSheet> {
  if (buffer.subarray(0, 4).equals(XLSX_MAGIC)) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw badRequest('INVALID_FILE', 'Could not read the Excel file');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('EMPTY_FILE', 'The workbook has no sheets');
    if (ws.rowCount > maxRows + 50) throw badRequest('TOO_MANY_ROWS', `The file has more than ${maxRows} rows`, { maxRows });
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[]; // 1-based
      matrix.push(values.slice(1).map(cellText));
    });
    return toRecords(matrix, maxRows);
  }
  if (/\.(xls|xlsb|ods|numbers)$/i.test(filename)) throw badRequest('UNSUPPORTED_FILE', 'Save the file as .xlsx or .csv');
  let text = buffer.toString('utf8');
  if (text.includes('\u0000')) throw badRequest('UNSUPPORTED_FILE', 'Unsupported file type');
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  try {
    const matrix = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
    return toRecords(matrix, maxRows);
  } catch (e) {
    if ((e as { code?: string }).code === 'TOO_MANY_ROWS') throw e;
    if (e instanceof Error && 'status' in e) throw e;
    throw badRequest('INVALID_FILE', 'Could not read the CSV file');
  }
}

/** Neutralizes spreadsheet formula injection in exported cells. */
export function safeCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): Buffer {
  const esc = (v: unknown) => {
    const s = safeCell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  return Buffer.from('﻿' + body, 'utf8'); // BOM so Excel opens Arabic correctly
}

export async function toXlsx(sheetName: string, headers: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r.map(safeCell));
  ws.columns.forEach((c) => (c.width = 20));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

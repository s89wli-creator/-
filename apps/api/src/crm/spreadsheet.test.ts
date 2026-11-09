import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseSpreadsheet, safeCell, toCsv } from './spreadsheet';

describe('parseSpreadsheet', () => {
  it('parses CSV with BOM, semicolons, quotes and Arabic', async () => {
    const csv = '﻿اسم الشركة;المدينة;ملاحظات\n"مصنع ""الأمل""";الرياض;"سطر1\nسطر2"\n;;\nشركة ب;جدة;\n';
    const r = await parseSpreadsheet(Buffer.from(csv), 'a.csv', 100);
    expect(r.headers).toEqual(['اسم الشركة', 'المدينة', 'ملاحظات']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ 'اسم الشركة': 'مصنع "الأمل"', المدينة: 'الرياض', ملاحظات: 'سطر1\nسطر2' });
  });

  it('parses XLSX by content (first sheet), dedupes headers, reads formula results without evaluating', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['الاسم', 'الهاتف', 'الهاتف']);
    ws.addRow(['شركة أ', '0501234567', { formula: '1+1', result: 2 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseSpreadsheet(buf, 'renamed.bin', 100);
    expect(r.headers).toEqual(['الاسم', 'الهاتف', 'الهاتف (2)']);
    expect(r.rows[0]).toEqual({ الاسم: 'شركة أ', الهاتف: '0501234567', 'الهاتف (2)': '2' });
  });

  it('enforces the row limit and rejects empty or binary files', async () => {
    const csv = 'name\n' + Array.from({ length: 6 }, (_, i) => `c${i}`).join('\n');
    await expect(parseSpreadsheet(Buffer.from(csv), 'a.csv', 5)).rejects.toMatchObject({ code: 'TOO_MANY_ROWS' });
    await expect(parseSpreadsheet(Buffer.from('name\n'), 'a.csv', 5)).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    await expect(parseSpreadsheet(Buffer.from([0, 1, 2, 0]), 'a.csv', 5)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(parseSpreadsheet(Buffer.from('x'), 'old.xls', 5)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});

describe('export safety', () => {
  it('neutralizes formula injection', () => {
    expect(safeCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    expect(safeCell('+966500000000')).toBe(`'+966500000000`);
    expect(safeCell('عادي')).toBe('عادي');
  });
  it('writes CSV with BOM and quoting', () => {
    const s = toCsv(['a', 'b'], [['x,y', '=1']]).toString('utf8');
    expect(s).toBe('﻿a,b\r\n"x,y",\'=1');
  });
});

/**
 * CSV export safe against Formula / CSV injection:
 * cells starting with = + - @ TAB or CR are prefixed with a single quote, and every cell is quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  // BOM so Excel opens Arabic text correctly
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Build a CSV string. Values that could be read as formulas by spreadsheet apps are neutralised. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
}

/* ---------- Export to Excel ---------- */
export interface ExportRequest { name: string; headers: string[]; rows: (string | number | null | undefined)[][]; sheet?: string }
const exportListeners = new Set<(r: ExportRequest) => void>();
/** The Export to Excel dialog (src/ui/ExportDialog.tsx) listens here. */
export function onExport(f: (r: ExportRequest) => void) { exportListeners.add(f); return () => { exportListeners.delete(f); }; }

/** "Export to Excel": opens the dialog (choose dates and branch), which downloads an .xlsx file.
 *  Kept under its old name so every list's export button uses it. */
export function downloadCsv(name: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const req = { name: name.replace(/\.csv$/i, ''), headers, rows };
  if (exportListeners.size) exportListeners.forEach(f => f(req));
  else import('./xlsx').then(m => m.downloadXlsx(req.name, headers, rows));
}

// A single source-role uploader: pick a file → validated client-side → uploaded
// with a progress bar. On success it calls onUploaded so the parent can refresh
// the modules query.

import { useCallback, useRef, useState } from "react";
import { uploadWithProgress } from "../../lib/upload";
import { toast } from "../../components/toast";

interface CsvColumnSpec {
  required: string[];
  suggested: string[];
}

interface CsvPreview {
  file: File;
  header: string[];
  rows: string[][];
  missingRequired: string[];
  missingSuggested: string[];
}

interface Props {
  moduleKey: string;
  sourceRole: string;
  acceptedExtensions: string[];
  autoActivate: boolean;
  maxUploadMb: number;
  onUploaded: () => void;
  /** Notified true while an upload is in flight, false when it ends. */
  onUploadingChange?: (uploading: boolean) => void;
  /** When set, a picked CSV is parsed client-side into a column-check preview
   *  before the upload starts. Mirror of the loader's header keys. */
  csvColumns?: CsvColumnSpec;
}

/** Tracks whether ANY of a page's UploadFields is currently uploading, so the
 *  page can disable Import until every upload finishes. */
export function useUploadTracker(): {
  uploading: boolean;
  onUploadingChange: (active: boolean) => void;
} {
  const [count, setCount] = useState(0);
  const onUploadingChange = useCallback((active: boolean) => {
    setCount((c) => Math.max(0, c + (active ? 1 : -1)));
  }, []);
  return { uploading: count > 0, onUploadingChange };
}

export function UploadField({
  moduleKey,
  sourceRole,
  acceptedExtensions,
  autoActivate,
  maxUploadMb,
  onUploaded,
  onUploadingChange,
  csvColumns,
}: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const accept = acceptedExtensions.join(",");

  async function uploadNow(file: File): Promise<void> {
    setPct(0);
    onUploadingChange?.(true);
    try {
      const result = await uploadWithProgress(
        file,
        { moduleKey, sourceRole, filename: file.name, autoActivate },
        setPct,
      );
      toast.success(result.duplicate ? "Duplicate upload skipped" : `Uploaded ${file.name}`);
      onUploaded();
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err));
    } finally {
      setPct(null);
      setPreview(null);
      onUploadingChange?.(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function runCsvPreview(file: File): void {
    void (async () => {
      let text: string;
      try {
        text = (await file.text()).replace(/^\uFEFF/, "");
      } catch {
        toast.error("Could not read the CSV file");
        return;
      }
      const rows = parseCsv(text);
      if (rows.length === 0) {
        toast.error("CSV is empty — no header row found");
        return;
      }
      const header = rows[0].map((h) => (h ?? "").trim());
      const missingRequired = (csvColumns?.required ?? []).filter((c) => !header.includes(c));
      const missingSuggested = (csvColumns?.suggested ?? []).filter((c) => !header.includes(c));
      setPreview({
        file,
        header,
        rows: rows.slice(1, 6),
        missingRequired,
        missingSuggested,
      });
      if (inputRef.current) inputRef.current.value = "";
    })();
  }

  async function handleFile(file: File): Promise<void> {
    const lower = file.name.toLowerCase();
    if (!acceptedExtensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
      toast.error(`File type not allowed. Accepted: ${acceptedExtensions.join(", ")}`);
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      toast.error(`File exceeds the ${maxUploadMb} MB limit`);
      return;
    }
    if (csvColumns) {
      runCsvPreview(file);
      return;
    }
    await uploadNow(file);
  }

  function cancelPreview(): void {
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <span className="upload-field">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {pct === null ? (
          <button type="button" className="btn btn--sm" onClick={() => inputRef.current?.click()}>
            Upload…
          </button>
        ) : (
          <span className="upload-progress">
            <span className="upload-progress__bar" style={{ width: `${pct}%` }} />
            <span className="upload-progress__label">{pct}%</span>
          </span>
        )}
      </span>
      {preview && (
        <div className="csv-preview" role="dialog" aria-label="CSV preview">
          <div className="csv-preview__head">
            <strong>{preview.file.name}</strong>
            <span className="muted small">({preview.rows.length + 1} rows shown)</span>
            <button type="button" className="btn btn--sm" onClick={cancelPreview}>
              Cancel
            </button>
          </div>
          <div className="csv-preview__checks">
            {preview.missingRequired.length > 0 && (
              <div className="csv-preview__fail small">
                Missing required column(s): {preview.missingRequired.join(", ")}. Upload blocked.
              </div>
            )}
            {preview.missingSuggested.length > 0 && (
              <div className="muted small">
                Missing optional column(s): {preview.missingSuggested.join(", ")}
              </div>
            )}
            {preview.missingRequired.length === 0 && (
              <div className="csv-preview__ok small">All required columns present.</div>
            )}
          </div>
          <table className="csv-preview__table">
            <thead>
              <tr>
                {preview.header.map((col, i) => (
                  <th key={i}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, ri) => (
                <tr key={ri}>
                  {preview.header.map((_, ci) => (
                    <td key={ci}>{row[ci] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={preview.missingRequired.length > 0}
            onClick={() => void uploadNow(preview.file)}
          >
            Start upload
          </button>
        </div>
      )}
    </>
  );
}

/** Minimal RFC4180 CSV parser — mirrors the server's parseCsv in adminSources.ts. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let started = false;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < text.length) {
    const ch = text[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (started || field.length > 0 || row.length > 0) pushRow();
  return rows;
}

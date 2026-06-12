// A single source-role uploader: pick a file → validated client-side → uploaded
// with a progress bar. On success it calls onUploaded so the parent can refresh
// the modules query.

import { useCallback, useRef, useState } from "react";
import { uploadWithProgress } from "../../lib/upload";
import { toast } from "../../components/toast";

interface Props {
  moduleKey: string;
  sourceRole: string;
  acceptedExtensions: string[];
  autoActivate: boolean;
  maxUploadMb: number;
  onUploaded: () => void;
  /** Notified true while an upload is in flight, false when it ends. */
  onUploadingChange?: (uploading: boolean) => void;
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
}: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const accept = acceptedExtensions.join(",");

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
      onUploadingChange?.(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
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
  );
}

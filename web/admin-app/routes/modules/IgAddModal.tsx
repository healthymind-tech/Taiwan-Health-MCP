import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { toast } from "../../components/toast";
import { Modal } from "../../components/Modal";
import { uploadWithProgress } from "../../lib/upload";

interface RegistryHit {
  name: string;
  description: string;
  fhirVersion: string;
}

type Tab = "registry" | "upload";

export function IgAddModal({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("registry");
  return (
    <Modal title="Add Implementation Guide" onClose={onClose} wide>
      <div className="ig-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "registry"}
          className={`ig-tab ${tab === "registry" ? "is-active" : ""}`}
          onClick={() => setTab("registry")}
        >
          From registry
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "upload"}
          className={`ig-tab ${tab === "upload" ? "is-active" : ""}`}
          onClick={() => setTab("upload")}
        >
          Upload .tgz
        </button>
      </div>
      {tab === "registry" ? (
        <RegistryTab onStarted={onStarted} onCancel={onClose} />
      ) : (
        <UploadTab onStarted={onStarted} onCancel={onClose} />
      )}
    </Modal>
  );
}

function RegistryTab({
  onStarted,
  onCancel,
}: {
  onStarted: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pkgId, setPkgId] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const searchQ = useQuery({
    queryKey: qk.registrySearch(debounced),
    queryFn: () =>
      api.get<{ results: RegistryHit[] }>(
        `/admin/api/registry/search?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });

  const importMut = useMutation({
    mutationFn: (body: { package_id: string; version?: string }) =>
      api.post("/admin/api/igs/import", { source: "registry", ...body }),
    onSuccess: () => {
      toast.success("IG import started — fetching package and dependencies");
      onStarted();
    },
    onError: (err) => toast.error(`Failed to start import: ${String(err)}`),
  });

  const results = searchQ.data?.results ?? [];

  function pick(name: string) {
    setPkgId(name);
    setVersion("");
  }

  // Allow a directly typed "packageId@version" without a registry hit.
  function applyTyped() {
    const raw = query.trim();
    if (!raw || pkgId) return;
    const [id, ver] = raw.includes("@") ? raw.split("@") : [raw, ""];
    setPkgId(id.trim());
    setVersion((ver || "").trim());
  }

  return (
    <div className="fhir-form">
      <p className="field-help" style={{ marginTop: -4 }}>
        Search the public FHIR package registry and import a package by id. Its declared
        dependency IGs are fetched automatically.
      </p>

      <div className="fhir-form-grid">
        <label className="fhir-form-wide">
          <span>Search the registry</span>
          <input
            type="text"
            placeholder="e.g. hl7.fhir.us.core   (or paste packageId@version)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={applyTyped}
            autoFocus
          />
          <small className="field-help">
            Type at least 2 characters to search, or paste an exact{" "}
            <code>packageId@version</code> and click Import.
          </small>
        </label>
      </div>

      {debounced.length >= 2 && (
        <div className="ig-add__results" role="listbox" aria-label="Registry results">
          {searchQ.isPending ? (
            <span className="ig-add__results-count">Searching…</span>
          ) : searchQ.isError ? (
            <small className="field-error">Registry search failed: {String(searchQ.error)}</small>
          ) : results.length === 0 ? (
            <span className="ig-add__results-count">
              No matches — import by exact packageId@version above.
            </span>
          ) : (
            <span className="ig-add__results-count" aria-live="polite">
              {results.length} result{results.length === 1 ? "" : "s"}
            </span>
          )}
          {results.map((r) => (
            <button
              type="button"
              key={r.name}
              role="option"
              aria-selected={r.name === pkgId}
              className={`ig-add__result ${r.name === pkgId ? "is-active" : ""}`}
              onClick={() => pick(r.name)}
            >
              <div className="ig-add__result-name">{r.name}</div>
              <div className="ig-add__result-meta">
                {r.fhirVersion && <span className="chip chip--muted">{r.fhirVersion}</span>}
                {r.description && <span className="ig-add__result-desc">{r.description}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="fhir-form-grid">
        <label>
          <span>Package ID</span>
          <input
            type="text"
            placeholder="hl7.fhir.us.core"
            value={pkgId}
            onChange={(e) => setPkgId(e.target.value)}
          />
        </label>
        <label>
          <span>Version</span>
          <input
            type="text"
            placeholder="latest"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
          <small className="field-help">Leave blank for the latest published version.</small>
        </label>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--active"
          disabled={!pkgId.trim() || importMut.isPending}
          onClick={() =>
            importMut.mutate({
              package_id: pkgId.trim(),
              version: version.trim() || undefined,
            })
          }
        >
          {importMut.isPending ? "Starting…" : "Import"}
        </button>
      </div>
    </div>
  );
}

function UploadTab({
  onStarted,
  onCancel,
}: {
  onStarted: () => void;
  onCancel: () => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".tgz") && !lower.endsWith(".tar.gz")) {
      toast.error("IG package must be a .tgz / .tar.gz file");
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const result = await uploadWithProgress(
        file,
        { moduleKey: "ig", sourceRole: "ig", filename: file.name, autoActivate: false },
        (pct) => setProgress(pct),
      );
      const uploadedFileId = String(
        (result.uploaded_file as Record<string, unknown> | undefined)?.uploaded_file_id ?? "",
      );
      if (!uploadedFileId) throw new Error("upload did not return a file id");
      await api.post("/admin/api/igs/import", {
        source: "upload",
        uploaded_file_id: uploadedFileId,
      });
      toast.success("IG import started from uploaded package");
      onStarted();
    } catch (err) {
      toast.error(`Upload/import failed: ${String(err)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="fhir-form">
      <p className="field-help" style={{ marginTop: -4 }}>
        Upload a FHIR IG package (<code>.tgz</code>) for a private IG or one the registry cannot
        supply. Declared dependency IGs are still auto-fetched from the registry.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".tgz,.tar.gz"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      <div className="ig-add__upload-drop">
        <button
          type="button"
          className="btn btn--active"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose package.tgz"}
        </button>
        {progress !== null && (
          <div className="progress" aria-label="Upload progress">
            <div className="progress__bar" style={{ width: `${progress}%` }} />
            <span className="progress__label">{progress}%</span>
          </div>
        )}
        <small className="field-help">Accepted: .tgz, .tar.gz</small>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

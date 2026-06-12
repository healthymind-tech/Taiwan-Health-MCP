import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { toast } from "../../components/toast";
import { Modal } from "../../components/Modal";
import { uploadWithProgress } from "../../lib/upload";

interface DepNode {
  package_id: string;
  version: string;
  installed: boolean;
}
interface MissingDep {
  package_id: string;
  version: string;
}
interface CodeSystemRow {
  cs_id: string;
  name: string;
  concept_count: number;
}
interface IgDetail {
  package_id: string;
  version: string;
  title: string;
  canonical: string | null;
  fhir_version: string | null;
  status: string | null;
  is_default: boolean;
  imported_at: string | null;
  counts: { artifacts: number; codesystems: number; concepts: number };
  dependencies: DepNode[];
  deps_missing: MissingDep[];
  dependents: { package_id: string; version: string }[];
  codesystems: CodeSystemRow[];
  external_systems: string[];
}

export function IgDetailDrawer({
  packageId,
  version,
  onClose,
  onChanged,
}: {
  packageId: string;
  version: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: qk.igDetail(packageId, version),
    queryFn: () =>
      api.get<IgDetail>(
        `/admin/api/igs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}`,
      ),
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: qk.igDetail(packageId, version) });
    void qc.invalidateQueries({ queryKey: qk.jobs });
    onChanged();
  }

  const setDefault = useMutation({
    mutationFn: () =>
      api.post(
        `/admin/api/igs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/default`,
        {},
      ),
    onSuccess: () => {
      invalidate();
      toast.success(`${packageId} is now the default IG`);
    },
    onError: (err) => toast.error(String(err)),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.del<{ removed: boolean; dependents: { package_id: string }[] }>(
        `/admin/api/igs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}`,
      ),
    onSuccess: (res) => {
      onChanged();
      toast.success(`Removed ${packageId}@${version}`);
      if (res.dependents?.length) {
        toast.error(
          `Warning: ${res.dependents.length} installed IG(s) still depend on this package`,
        );
      }
      onClose();
    },
    onError: (err) => toast.error(String(err)),
  });

  const retryDep = useMutation({
    mutationFn: (dep: MissingDep) =>
      api.post("/admin/api/igs/import", {
        source: "registry",
        package_id: dep.package_id,
        version: dep.version,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Fetching missing dependency from registry…");
    },
    onError: (err) => toast.error(`Failed: ${String(err)}`),
  });

  const d = detailQ.data;

  function confirmRemove() {
    if (
      window.confirm(
        `Remove IG ${packageId}@${version}?\n\nThis deletes its CodeSystems, concepts, and ` +
          `artifacts. Other IGs that depend on it will show it as a missing dependency. ` +
          `This cannot be undone.`,
      )
    ) {
      remove.mutate();
    }
  }

  return (
    <Modal
      title={d ? d.title : `${packageId}@${version}`}
      onClose={onClose}
      wide
    >
      {detailQ.isPending ? (
        <div className="muted">Loading…</div>
      ) : detailQ.isError || !d ? (
        <div className="error-box">Failed to load IG detail: {String(detailQ.error)}</div>
      ) : (
        <div className="ig-detail">
          <div className="ig-detail__head">
            <div>
              <div className="ig-detail__pkg">
                {d.package_id} <span className="badge badge--muted">v{d.version}</span>
                {d.is_default && <span className="badge badge--ok">default</span>}
              </div>
              {d.canonical && (
                <a
                  className="muted small ig-detail__canonical"
                  href={d.canonical}
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.canonical}
                </a>
              )}
            </div>
            <div className="head-actions">
              {!d.is_default && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={setDefault.isPending}
                  onClick={() => setDefault.mutate()}
                >
                  Set default
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={remove.isPending}
                onClick={confirmRemove}
              >
                Remove
              </button>
            </div>
          </div>

          <div className="ig-detail__facts">
            <Fact label="FHIR version" value={d.fhir_version ?? "—"} />
            <Fact label="Status" value={d.status ?? "—"} />
            <Fact label="Imported" value={d.imported_at ? formatRelative(d.imported_at) : "—"} />
            <Fact label="Artifacts" value={d.counts.artifacts.toLocaleString()} />
            <Fact label="CodeSystems" value={d.counts.codesystems.toLocaleString()} />
            <Fact label="Concepts" value={d.counts.concepts.toLocaleString()} />
          </div>

          <Section title={`Dependencies (${d.dependencies.length})`}>
            {d.dependencies.length === 0 ? (
              <div className="muted small">This IG declares no dependency IGs.</div>
            ) : (
              <ul className="ig-dep-list">
                {d.dependencies.map((dep) => (
                  <li key={`${dep.package_id}@${dep.version}`} className="ig-dep">
                    <span className="ig-dep__name">
                      {dep.package_id}
                      <span className="badge badge--muted">v{dep.version}</span>
                    </span>
                    {dep.installed ? (
                      <span className="chip chip--ok">installed</span>
                    ) : (
                      <span className="ig-dep__missing">
                        <span className="chip chip--warn">missing</span>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={retryDep.isPending}
                          onClick={() =>
                            retryDep.mutate({
                              package_id: dep.package_id,
                              version: dep.version,
                            })
                          }
                        >
                          Retry from registry
                        </button>
                        <DepUpload depId={dep.package_id} onDone={invalidate} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {d.dependents.length > 0 && (
            <Section title={`Required by (${d.dependents.length})`}>
              <ul className="ig-dep-list">
                {d.dependents.map((dep) => (
                  <li key={`${dep.package_id}@${dep.version}`} className="ig-dep">
                    <span className="ig-dep__name">
                      {dep.package_id}
                      <span className="badge badge--muted">v{dep.version}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={`CodeSystems defined here (${d.codesystems.length})`}>
            {d.codesystems.length === 0 ? (
              <div className="muted small">This IG defines no CodeSystems.</div>
            ) : (
              <ul className="ig-cs-list">
                {d.codesystems.slice(0, 50).map((cs) => (
                  <li key={cs.cs_id} className="ig-cs">
                    <span className="ig-cs__name">{cs.name}</span>
                    <span className="muted small">{cs.concept_count.toLocaleString()} codes</span>
                  </li>
                ))}
                {d.codesystems.length > 50 && (
                  <li className="muted small">…and {d.codesystems.length - 50} more</li>
                )}
              </ul>
            )}
          </Section>

          {d.external_systems.length > 0 && (
            <Section title={`Referenced external systems (${d.external_systems.length})`}>
              <div className="ig-ext-systems">
                {d.external_systems.slice(0, 40).map((s) => (
                  <code key={s} className="ig-ext-system">
                    {s}
                  </code>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </Modal>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="ig-detail__fact">
      <span className="ig-detail__fact-key">{label}</span>
      <span className="ig-detail__fact-value">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="ig-detail__section">
      <h4 className="ig-detail__section-title">{title}</h4>
      {children}
    </div>
  );
}

/** Inline "Upload .tgz" to satisfy a specific missing dependency. */
function DepUpload({ depId, onDone }: { depId: string; onDone: () => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function go(file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".tgz") && !lower.endsWith(".tar.gz")) {
      toast.error("Dependency package must be a .tgz / .tar.gz file");
      return;
    }
    setBusy(true);
    try {
      const result = await uploadWithProgress(
        file,
        { moduleKey: "ig", sourceRole: "ig", filename: file.name, autoActivate: false },
        () => {},
      );
      const uploadedFileId = String(
        (result.uploaded_file as Record<string, unknown> | undefined)?.uploaded_file_id ?? "",
      );
      if (!uploadedFileId) throw new Error("upload did not return a file id");
      await api.post("/admin/api/igs/import", {
        source: "upload",
        uploaded_file_id: uploadedFileId,
      });
      toast.success(`Importing uploaded package for ${depId}`);
      onDone();
    } catch (err) {
      toast.error(`Upload/import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".tgz,.tar.gz"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void go(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        onClick={() => ref.current?.click()}
      >
        {busy ? "Uploading…" : "Upload .tgz"}
      </button>
    </>
  );
}

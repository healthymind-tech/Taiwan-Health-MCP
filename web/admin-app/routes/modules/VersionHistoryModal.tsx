// Version history for a module's uploaded sources, grouped by source role.

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { formatRelative } from "../../lib/time";
import { Modal } from "../../components/Modal";
import { StatusBadge } from "../../components/StatusBadge";
import type { SourceVersion } from "../../lib/types";

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function VersionHistoryModal({
  moduleKey,
  label,
  onClose,
}: {
  moduleKey: string;
  label: string;
  onClose: () => void;
}): JSX.Element {
  const { data, isPending, isError, error } = useQuery({
    queryKey: qk.moduleVersions(moduleKey),
    queryFn: () => api.get<{ versions: SourceVersion[] }>(`/admin/api/modules/${moduleKey}/versions`),
  });

  // Preserve the backend's newest-first ordering while grouping by role.
  const byRole = new Map<string, SourceVersion[]>();
  for (const v of data?.versions ?? []) {
    const list = byRole.get(v.role_label) ?? [];
    list.push(v);
    byRole.set(v.role_label, list);
  }

  return (
    <Modal title={`${label} — version history`} onClose={onClose} wide>
      {isPending ? (
        <div className="muted">Loading versions…</div>
      ) : isError ? (
        <div className="error-box">Failed to load versions: {String(error)}</div>
      ) : byRole.size === 0 ? (
        <div className="muted">No version history yet.</div>
      ) : (
        [...byRole.entries()].map(([role, versions]) => (
          <div key={role} style={{ marginBottom: 18 }}>
            <h4 className="subhead">{role}</h4>
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Ver</th>
                  <th>File</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th>By</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.module_source_id}>
                    <td data-label="Ver">
                      v{v.version_num ?? "—"}{" "}
                      {v.is_active && <span className="badge badge--ok">active</span>}
                    </td>
                    <td data-label="File">{v.original_filename}</td>
                    <td className="muted small" data-label="Size">{formatBytes(v.size_bytes)}</td>
                    <td className="muted small" data-label="Uploaded">{formatRelative(v.uploaded_at)}</td>
                    <td className="muted small" data-label="By">{v.uploaded_by}</td>
                    <td data-label="Status">
                      <StatusBadge status={v.validation_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Modal>
  );
}

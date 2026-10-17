import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import type { JobStatus, JobStatusChangedEvent, WsEnvelope } from "./types";
import { TERMINAL_STATUSES } from "./meta";
import { pushLiveLog } from "./liveLogs";

/** Map each WebSocket event to the server state it invalidates. */
export function dispatchWsInvalidation(qc: QueryClient, evt: WsEnvelope): void {
  switch (evt.type) {
    case "job_status_changed": {
      const data = evt.data as unknown as JobStatusChangedEvent;
      void qc.invalidateQueries({ queryKey: qk.jobs });
      if (!TERMINAL_STATUSES.has(data.status as JobStatus)) return;
      void qc.invalidateQueries({ queryKey: qk.modules });
      void qc.invalidateQueries({ queryKey: qk.overview });
      void qc.invalidateQueries({ queryKey: qk.igs });
      void qc.invalidateQueries({ queryKey: qk.drug });
      void qc.invalidateQueries({ queryKey: qk.backups });
      // An import can cross a module's row-count threshold and enable its MCP tools.
      if (data.status === "success" || data.status === "partial_success") void qc.invalidateQueries({ queryKey: qk.mcpTools });
      if (data.job_type?.endsWith("_embed")) void qc.invalidateQueries({ queryKey: qk.embedding });
      return;
    }
    case "job_step_updated":
      void qc.invalidateQueries({ queryKey: qk.jobs });
      return;
    case "job_log_line":
      pushLiveLog(evt.data as never);
      return;
    case "worker_heartbeat":
      void qc.invalidateQueries({ queryKey: qk.workers });
      return;
    case "maintenance_changed":
    case "module_cleared":
    default:
      if ((evt.type as string) === "module_changed" || evt.type === "maintenance_changed" || evt.type === "module_cleared") {
        void qc.invalidateQueries({ queryKey: qk.modules });
        void qc.invalidateQueries({ queryKey: qk.overview });
        void qc.invalidateQueries({ queryKey: qk.embedding });
        void qc.invalidateQueries({ queryKey: qk.igs });
        void qc.invalidateQueries({ queryKey: qk.mcpTools });
      }
  }
}

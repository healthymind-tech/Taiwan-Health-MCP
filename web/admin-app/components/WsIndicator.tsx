// Live/Reconnecting indicator driven by the shared WebSocket connection.

import { useSyncExternalStore } from "react";
import { adminWs } from "../lib/ws";

export function WsIndicator(): JSX.Element {
  const connected = useSyncExternalStore(
    (cb) => adminWs.onStatus(() => cb()),
    () => adminWs.isConnected(),
  );
  return (
    <span className="ws-indicator" title={connected ? "Live updates connected" : "Reconnecting…"}>
      <span className={`ws-dot ${connected ? "ws-dot--on" : "ws-dot--off"}`} />
      {connected ? "Live" : "Reconnecting…"}
    </span>
  );
}

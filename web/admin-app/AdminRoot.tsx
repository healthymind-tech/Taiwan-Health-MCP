"use client";

import { StrictMode, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { adminWs } from "./lib/ws";
import { dispatchWsInvalidation } from "./lib/wsInvalidation";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Bridge the shared WebSocket into the query cache: every event runs through
// the invalidation map so server state stays fresh without manual reloads.
function WsBridge(): null {
  useEffect(() => {
    const unsubscribe = adminWs.subscribe((evt) => dispatchWsInvalidation(queryClient, evt));
    adminWs.start();
    return unsubscribe;
  }, []);
  return null;
}

export default function AdminRoot(): JSX.Element {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Mounted under /admin by the Next.js catch-all route. */}
        <BrowserRouter basename="/admin">
          <WsBridge />
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}

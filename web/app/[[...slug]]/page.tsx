"use client";

import dynamic from "next/dynamic";

// The admin console is a React Router SPA; render it client-only (BrowserRouter
// needs window). The optional catch-all matches /admin and every nested path so
// client-side routing works on hard refresh.
const AdminRoot = dynamic(() => import("@/admin-app/AdminRoot"), { ssr: false });

export default function AdminCatchAll(): JSX.Element {
  return <AdminRoot />;
}

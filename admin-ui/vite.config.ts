import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the Python ASGI app under /admin, so every asset URL
// must be prefixed with /admin/. In dev, proxy the API + WebSocket to the
// running Python server (default :8000) so cookies stay same-origin.
const PY_BACKEND = process.env.ADMIN_API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    // Emitted into admin-ui/dist; the Python server serves dist/ at /admin.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": { target: PY_BACKEND, changeOrigin: true },
      "/admin/ws": { target: PY_BACKEND, changeOrigin: true, ws: true },
      // Reuse the server-rendered login page in dev too.
      "/admin/login": { target: PY_BACKEND, changeOrigin: true },
      "/admin/logout": { target: PY_BACKEND, changeOrigin: true },
    },
  },
});

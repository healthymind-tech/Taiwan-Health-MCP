import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The console is served under /admin (same origin as /admin/api and /admin/ws,
// which the session cookie is scoped to). In dev, proxy the API to a running
// backend — by default the isolated staging stack on :8090.
const BACKEND = process.env.ADMIN_BACKEND ?? "http://127.0.0.1:8090";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": { target: BACKEND, changeOrigin: false },
      "/admin/ws": { target: BACKEND, ws: true },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          mantine: ["@mantine/core", "@mantine/hooks", "@mantine/notifications", "@mantine/modals", "@mantine/dropzone"],
          charts: ["@mantine/charts", "recharts"],
        },
      },
    },
  },
});

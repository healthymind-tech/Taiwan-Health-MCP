/** @type {import('next').NextConfig} */
// In production nginx is the single front door and routes API/MCP/WS to the
// Node backend app service; these rewrites mirror that map so `next dev` works standalone.
const BACKEND = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const nextConfig = {
  output: "standalone",
  basePath: "/admin",
  async rewrites() {
    return [
      // These mirror nginx routes that live at the domain root in production
      // (nginx never sends them through this Next app there); basePath:false
      // keeps `next dev` matching the same root-level paths.
      { source: "/mcp", destination: `${BACKEND}/mcp`, basePath: false },
      { source: "/openapi.json", destination: `${BACKEND}/openapi.json`, basePath: false },
      { source: "/tools/:path*", destination: `${BACKEND}/tools/:path*`, basePath: false },
      { source: "/fhir-client/:path*", destination: `${BACKEND}/fhir-client/:path*`, basePath: false },
      { source: "/fhir-oauth/:path*", destination: `${BACKEND}/fhir-oauth/:path*`, basePath: false },
      // Frontend calls fetch("/admin/api/...") literally; basePath auto-prepends
      // /admin to this source so it matches that request path.
      { source: "/api/:path*", destination: `${BACKEND}/admin/api/:path*` },
    ];
  },
};

module.exports = nextConfig;

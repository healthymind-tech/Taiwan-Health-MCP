/** @type {import('next').NextConfig} */
// In production nginx is the single front door and routes API/MCP/WS to the
// Python backend; these rewrites mirror that map so `next dev` works standalone.
const BACKEND = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const nextConfig = {
  output: "standalone",
  // Ensure the verbatim legacy HTML is traced into the standalone bundle.
  experimental: {
    outputFileTracingIncludes: { "/status": ["./legacy/**/*"], "/": ["./legacy/**/*"] },
  },
  async rewrites() {
    return [
      { source: "/mcp", destination: `${BACKEND}/mcp` },
      { source: "/status.json", destination: `${BACKEND}/status.json` },
      { source: "/openapi.json", destination: `${BACKEND}/openapi.json` },
      { source: "/tools/:path*", destination: `${BACKEND}/tools/:path*` },
      { source: "/admin/api/:path*", destination: `${BACKEND}/admin/api/:path*` },
      { source: "/fhir-client/:path*", destination: `${BACKEND}/fhir-client/:path*` },
      { source: "/fhir-oauth/:path*", destination: `${BACKEND}/fhir-oauth/:path*` },
    ];
  },
};

module.exports = nextConfig;

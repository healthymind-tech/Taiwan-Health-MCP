import fs from "node:fs";
import path from "node:path";

const LEGACY_DIR = path.join(process.cwd(), "legacy");

/** Read a verbatim legacy HTML document extracted from src/server.py. */
export function loadLegacy(name: string): string {
  return fs.readFileSync(path.join(LEGACY_DIR, name), "utf-8");
}

// The privacy & DPA pages shipped light-only (no theme script, no dark CSS).
// This block is injected before </head> to give them the same dark mode as the
// landing/status pages — driven by the shared `admin-theme` key / OS preference.
const DARK_HEAD = `
  <meta name="color-scheme" content="light dark">
  <script>
    (function () {
      try {
        var t = localStorage.getItem('admin-theme');
        if (t !== 'light' && t !== 'dark') {
          t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.dataset.theme = t;
      } catch (e) {}
    })();
  </script>
  <style>
    /* dark mode added during the Next.js migration (parity with landing/status) */
    [data-theme="dark"] body { background: #0f1115; color: #e6e8eb; }
    [data-theme="dark"] nav { background: #15181e; border-bottom-color: #262b35; }
    [data-theme="dark"] h1, [data-theme="dark"] h2 { color: #e6e8eb; }
    [data-theme="dark"] strong { color: #f1f3f5; }
    [data-theme="dark"] em { color: #aab2bf; }
    [data-theme="dark"] code { background: #1b1f27; color: #e0b84d; }
    [data-theme="dark"] a { color: #5aa2ff; }
  </style>
`;

/** Inject the dark-mode head block before </head> (idempotent enough for one call). */
export function withDarkMode(html: string): string {
  return html.replace("</head>", `${DARK_HEAD}</head>`);
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
export function htmlResponse(html: string, init?: ResponseInit): Response {
  return new Response(html, { ...init, headers: { ...HTML_HEADERS, ...(init?.headers || {}) } });
}

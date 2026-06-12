import type { ReactNode } from "react";

export const metadata = {
  title: "Taiwan Health MCP",
};

// No-flash theme bootstrap: reads the shared `admin-theme` key (same one the
// admin console and legacy pages use) and falls back to the OS preference,
// setting <html data-theme> before first paint. Mirrors src/server.py:1408.
const themeScript = `(function(){try{var t=localStorage.getItem('admin-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

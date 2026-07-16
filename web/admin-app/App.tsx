import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { OverviewPage } from "./routes/overview/OverviewPage";
import { ServicesPage } from "./routes/services/ServicesPage";
import { ModulesLayout } from "./routes/modules/ModulesLayout";
import { ModulePage } from "./routes/modules/ModulePage";
import { FhirServersPage } from "./routes/modules/FhirServersPage";
import { DrugExplorerPage } from "./routes/modules/drug/DrugExplorerPage";
import { GuidelineReviewPage } from "./routes/modules/guideline/GuidelineReviewPage";
import { GuidelineExplorerPage } from "./routes/modules/guideline/GuidelineExplorerPage";
import { UPLOAD_MODULE_ORDER } from "./lib/moduleMeta";
import { TasksPage } from "./routes/tasks/TasksPage";
import { SettingsPage } from "./routes/settings/SettingsPage";
import { WsIndicator } from "./components/WsIndicator";
import { ToastContainer } from "./components/toast";
import { DbHealthGate } from "./components/DbHealthGate";
import { useTheme } from "./lib/theme";

const TABS = [
  { path: "overview", label: "Overview" },
  { path: "services", label: "Services" },
  { path: "modules", label: "Modules" },
  { path: "tasks", label: "Tasks" },
  { path: "settings", label: "Settings" },
] as const;

// Sections with their own sub-navigation (Modules, Settings): re-clicking the
// top tab after navigating away used to always land back on the first
// module / default settings section, discarding whatever sub-tab was open.
// Remember the last sub-path visited within each such section (per browser
// tab, via sessionStorage) and route the top-level tab there instead.
const REMEMBERED_SECTIONS = ["modules", "settings"] as const;
const lastPathKey = (section: string): string => `admin-last-path:${section}`;

export default function App(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = (): void => setDrawerOpen(false);
  const { theme, toggle } = useTheme();
  const location = useLocation();

  const [lastPaths, setLastPaths] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const section of REMEMBERED_SECTIONS) {
      initial[section] = (typeof window !== "undefined" && sessionStorage.getItem(lastPathKey(section))) || `/${section}`;
    }
    return initial;
  });

  useEffect(() => {
    for (const section of REMEMBERED_SECTIONS) {
      if (location.pathname === `/${section}` || location.pathname.startsWith(`/${section}/`)) {
        sessionStorage.setItem(lastPathKey(section), location.pathname);
        setLastPaths((prev) => (prev[section] === location.pathname ? prev : { ...prev, [section]: location.pathname }));
      }
    }
  }, [location.pathname]);
  const signOut = (): void => {
    void fetch("/admin/api/logout", { method: "POST" }).finally(() => {
      window.location.href = "/admin/login";
    });
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <button
            type="button"
            className="topbar__menu-btn"
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="topbar__brand">Taiwan Health MCP — Admin</div>
        </div>
        <div className="topbar__right">
          <WsIndicator />
          <button
            type="button"
            className="btn btn--ghost theme-toggle"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost topbar__signout"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabbar">
        {TABS.map((t) => {
          const isActive = location.pathname === `/${t.path}` || location.pathname.startsWith(`/${t.path}/`);
          return (
            <Link key={t.path} to={lastPaths[t.path] ?? `/${t.path}`} className={`tab ${isActive ? "tab--active" : ""}`}>
              {t.label}
            </Link>
          );
        })}
      </nav>

      {drawerOpen && (
        <div className="nav-drawer">
          <div className="nav-drawer__overlay" onClick={closeDrawer} />
          <nav className="nav-drawer__panel" aria-label="Primary">
            <div className="nav-drawer__head">
              <span className="nav-drawer__title">Menu</span>
              <button
                type="button"
                className="nav-drawer__close"
                aria-label="Close navigation menu"
                onClick={closeDrawer}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            {TABS.map((t) => {
              const isActive = location.pathname === `/${t.path}` || location.pathname.startsWith(`/${t.path}/`);
              return (
                <Link
                  key={t.path}
                  to={lastPaths[t.path] ?? `/${t.path}`}
                  onClick={closeDrawer}
                  className={`nav-drawer__item ${isActive ? "nav-drawer__item--active" : ""}`}
                >
                  {t.label}
                </Link>
              );
            })}
            <button type="button" className="nav-drawer__item nav-drawer__signout" onClick={signOut}>
              Sign out
            </button>
          </nav>
        </div>
      )}

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/modules" element={<ModulesLayout />}>
            <Route index element={<Navigate to={UPLOAD_MODULE_ORDER[0]} replace />} />
            <Route path="fhir-servers" element={<FhirServersPage />} />
            <Route path="drug/explorer" element={<DrugExplorerPage />} />
            <Route path="guideline/review" element={<GuidelineReviewPage />} />
            <Route path="guideline/explorer" element={<GuidelineExplorerPage />} />
            <Route path=":moduleKey" element={<ModulePage />} />
          </Route>
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>

      <ToastContainer />
      <DbHealthGate />
    </div>
  );
}

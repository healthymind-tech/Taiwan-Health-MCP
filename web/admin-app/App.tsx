import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { OverviewPage } from "./routes/overview/OverviewPage";
import { ServicesPage } from "./routes/services/ServicesPage";
import { ModulesLayout } from "./routes/modules/ModulesLayout";
import { ModulePage } from "./routes/modules/ModulePage";
import { FhirServersPage } from "./routes/modules/FhirServersPage";
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
  { path: "tasks", label: "Tasks" },
  { path: "modules", label: "Modules" },
  { path: "settings", label: "Settings" },
] as const;

export default function App(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = (): void => setDrawerOpen(false);
  const { theme, toggle } = useTheme();

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
            className="btn btn--ghost"
            onClick={() => {
              void fetch("/admin/api/logout", { method: "POST" }).finally(() => {
                window.location.href = "/admin/login";
              });
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabbar">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={`/${t.path}`}
            className={({ isActive }) => `tab ${isActive ? "tab--active" : ""}`}
          >
            {t.label}
          </NavLink>
        ))}
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
            {TABS.map((t) => (
              <NavLink
                key={t.path}
                to={`/${t.path}`}
                onClick={closeDrawer}
                className={({ isActive }) =>
                  `nav-drawer__item ${isActive ? "nav-drawer__item--active" : ""}`
                }
              >
                {t.label}
              </NavLink>
            ))}
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
            <Route path=":moduleKey" element={<ModulePage />} />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>

      <ToastContainer />
      <DbHealthGate />
    </div>
  );
}

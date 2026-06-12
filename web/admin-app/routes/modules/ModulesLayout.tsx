// Modules tab shell: a horizontal sub-nav across the top listing every
// module, with each module's own page rendered full-width below it
// (/modules/:moduleKey). Replaces the old single long-scroll page and the
// earlier left-sidebar layout (which squeezed the content column).

import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ACTION_MODULES, UPLOAD_MODULE_META, UPLOAD_MODULE_ORDER } from "../../lib/moduleMeta";

/** Human label for the module currently shown — used by the mobile disclosure summary. */
function currentModuleLabel(pathname: string): string {
  const key = pathname.replace(/^\/modules\/?/, "").split("/")[0];
  if (!key) return "Select module";
  if (key === "fhir-servers") return "FHIR Servers";
  if (key in UPLOAD_MODULE_META) return UPLOAD_MODULE_META[key as keyof typeof UPLOAD_MODULE_META].label;
  const action = ACTION_MODULES.find((d) => d.moduleKey === key);
  return action ? action.label : "Select module";
}

export function ModulesLayout(): JSX.Element {
  const location = useLocation();
  // Controlled <details>: open on desktop (summary hidden, nav always shown),
  // collapsed on mobile until the user taps the summary. Controlling `open`
  // avoids relying on CSS to reveal a closed details' content on desktop.
  const isMobile = (): boolean => window.matchMedia("(max-width: 768px)").matches;
  const [navOpen, setNavOpen] = useState(() => !isMobile());
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `modules-nav__item ${isActive ? "modules-nav__item--active" : ""}`;
  // After picking a module on mobile, collapse the disclosure.
  const collapseMobile = (): void => {
    if (isMobile()) setNavOpen(false);
  };

  return (
    <section>
      <header className="section-head">
        <h2>Modules</h2>
      </header>
      <details
        className="modules-nav-wrap"
        open={navOpen}
        onToggle={(e) => setNavOpen(e.currentTarget.open)}
      >
        <summary className="modules-nav-wrap__summary">
          <span className="modules-nav-wrap__current">{currentModuleLabel(location.pathname)}</span>
          <span className="modules-nav-wrap__chevron" aria-hidden="true">▾</span>
        </summary>
        <nav className="modules-nav">
          <span className="modules-nav__group">Source uploads</span>
          {UPLOAD_MODULE_ORDER.map((key) => (
            <NavLink key={key} to={`/modules/${key}`} className={linkClass} onClick={collapseMobile}>
              {UPLOAD_MODULE_META[key].label}
            </NavLink>
          ))}
          <span className="modules-nav__sep" aria-hidden="true" />
          <span className="modules-nav__group">API sync &amp; seed</span>
          {ACTION_MODULES.map((ds) => (
            <NavLink key={ds.moduleKey} to={`/modules/${ds.moduleKey}`} className={linkClass} onClick={collapseMobile}>
              {ds.label}
            </NavLink>
          ))}
          <span className="modules-nav__sep" aria-hidden="true" />
          <span className="modules-nav__group">External systems</span>
          <NavLink to="/modules/fhir-servers" className={linkClass} onClick={collapseMobile}>
            FHIR Servers
          </NavLink>
        </nav>
      </details>
      <div className="modules-main">
        <Outlet />
      </div>
    </section>
  );
}

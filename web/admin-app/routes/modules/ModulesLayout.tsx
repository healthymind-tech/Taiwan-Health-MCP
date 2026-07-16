import type { LucideIcon } from "lucide-react";
import {
  Apple,
  BookOpenText,
  Boxes,
  Building2,
  Database,
  HeartPulse,
  Leaf,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ACTION_MODULES, UPLOAD_MODULE_META } from "../../lib/moduleMeta";

interface NavigationLink {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
}

interface NavigationGroup {
  label: string;
  links: NavigationLink[];
}

const ACTION_ICONS: Record<string, LucideIcon> = {
  guideline: BookOpenText,
  health_supplements: Leaf,
  food_nutrition: Apple,
};

const TERMINOLOGY_MODULE_ORDER = ["icd", "loinc", "snomed", "rxnorm"] as const;
const TERMINOLOGY_MODULE_KEYS = new Set<string>(TERMINOLOGY_MODULE_ORDER);

function moduleKeyFromPath(pathname: string): string {
  return pathname.replace(/^\/modules\/?/, "").split("/")[0] || TERMINOLOGY_MODULE_ORDER[0];
}

export function ModulesLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const moduleKey = moduleKeyFromPath(location.pathname);
  const isTerminologyModule = TERMINOLOGY_MODULE_KEYS.has(moduleKey);
  const activeSection = isTerminologyModule ? "terminology" : moduleKey;
  const terminologyPath = `/modules/${isTerminologyModule ? moduleKey : TERMINOLOGY_MODULE_ORDER[0]}`;

  const navigationGroups: NavigationGroup[] = [
    {
      label: "Source data",
      links: [
        { key: "terminology", label: "Terminology import", icon: Database, path: terminologyPath },
        { key: "ig", label: UPLOAD_MODULE_META.ig.label, icon: Boxes, path: "/modules/ig" },
        { key: "drug", label: UPLOAD_MODULE_META.drug.label, icon: HeartPulse, path: "/modules/drug" },
      ],
    },
    {
      label: "Managed feeds",
      links: ACTION_MODULES.map((module) => ({
        key: module.moduleKey,
        label: module.label,
        icon: ACTION_ICONS[module.moduleKey],
        path: `/modules/${module.moduleKey}`,
      })),
    },
    {
      label: "Connections",
      links: [
        { key: "fhir-servers", label: "FHIR Servers", icon: Building2, path: "/modules/fhir-servers" },
      ],
    },
  ];

  return (
    <section>
      <header className="section-head">
        <h2>Modules</h2>
      </header>

      <label className="modules-mobile-select">
        <span>Section</span>
        <select
          value={activeSection}
          onChange={(event) => {
            const link = navigationGroups
              .flatMap((group) => group.links)
              .find((item) => item.key === event.target.value);
            if (link) navigate(link.path);
          }}
        >
          {navigationGroups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.links.map((link) => (
                <option key={link.key} value={link.key}>{link.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="modules-workspace">
        <nav className="modules-sidebar" aria-label="Module categories">
          {navigationGroups.map((group) => (
            <div className="modules-sidebar__group" key={group.label}>
              <div className="modules-sidebar__label">{group.label}</div>
              {group.links.map((link) => {
                const Icon = link.icon;
                const active = activeSection === link.key;
                return (
                  <NavLink
                    key={link.key}
                    to={link.path}
                    className={`modules-sidebar__item ${active ? "modules-sidebar__item--active" : ""}`}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{link.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="modules-main">
          {isTerminologyModule && (
            <div className="import-module-picker">
              <div>
                <div className="import-module-picker__title">Terminology import</div>
                <div className="muted small">Choose the terminology you want to manage or import.</div>
              </div>
              <label>
                <span>Terminology</span>
                <select
                  value={moduleKey}
                  onChange={(event) => navigate(`/modules/${event.target.value}`)}
                >
                  {TERMINOLOGY_MODULE_ORDER.map((key) => (
                    <option key={key} value={key}>{UPLOAD_MODULE_META[key].label}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </section>
  );
}

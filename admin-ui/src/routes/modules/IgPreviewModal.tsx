import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { qk } from "../../lib/queryKeys";
import { Modal } from "../../components/Modal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ElementSource = "differential" | "snapshot";

interface TwcoreArtifactRow {
  node?: string;
  artifact_key?: string;
  resource_type?: string;
  artifact_id?: string;
  canonical_url?: string;
  title?: string;
  name?: string;
  status?: string;
  kind?: string;
  base_type?: string;
  derivation?: string;
  grouping_name?: string;
  description?: string;
  child_count?: number;
  profile_resource?: string;
}

interface TwcoreProfileResourceNode {
  resource_name: string;
  label: string;
  profile_count: number;
  child_count: number;
  profiles: TwcoreArtifactRow[];
}

interface TwcoreConstraint {
  key?: string;
  severity?: string;
  human?: string;
  expression?: string;
}

interface TwcoreElementNode {
  id: string;
  element_id?: string;
  path?: string;
  slice_name?: string;
  label?: string;
  depth?: number;
  cardinality?: string;
  required?: boolean;
  optional?: boolean;
  prohibited?: boolean;
  must_support?: boolean;
  is_modifier?: boolean;
  type?: string;
  binding?: string;
  binding_strength?: string;
  binding_description?: string;
  short?: string;
  definition?: string;
  comment?: string;
  requirements?: string;
  fixed_kind?: string;
  fixed_value?: string;
  constraints?: TwcoreConstraint[];
  children?: TwcoreElementNode[];
}

interface TwcoreCodeRow {
  row_type?: string;
  system?: string;
  code?: string;
  display?: string;
  definition?: string;
  meaning?: string;
  properties?: string;
  source?: string;
}

interface TwcorePreviewResult {
  type: string;
  profile_tree?: TwcoreProfileResourceNode[];
  element_tree?: TwcoreElementNode[];
  rows?: TwcoreCodeRow[];
  total?: number;
  per_page?: number;
  counts?: { codesystems?: number; profiles?: number; profile_resources?: number };
  message?: string;
}

interface TwcoreFieldResult extends TwcoreElementNode {
  artifact_key: string;
  artifact_id?: string;
  artifact_title?: string;
  base_type?: string;
  grouping_name?: string;
}

interface TwcoreSearchResult {
  field_results?: TwcoreFieldResult[];
  field_results_total?: number;
  rows?: TwcoreArtifactRow[];
  total?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elementKey(node: TwcoreElementNode): string {
  return node.id || node.element_id || node.path || "";
}

function artifactDisplay(row?: TwcoreArtifactRow): string {
  return row?.title || row?.name || row?.artifact_id || row?.artifact_key || "";
}

/** Stable, typeable token for a profile in a copyable path (prefers the id). */
function profileToken(row: TwcoreArtifactRow): string {
  return row.artifact_id || row.name || row.title || row.artifact_key || "";
}

// A single hop in the address-bar path: a resource, a profile, or an element.
interface Crumb {
  kind: "res" | "prof" | "el";
  label: string;
  resourceName: string;
  artifactKey?: string;
  elementId?: string;
}

/** Small inline button that copies a node's path to the clipboard. */
function CopyPathButton({ path }: { path: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="twctree__copy"
      title={`Copy path: ${path}`}
      aria-label="Copy path"
      onClick={(e) => {
        e.stopPropagation();
        const mark = () => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        };
        const write = navigator.clipboard?.writeText(path);
        if (write) write.then(mark).catch(() => {});
        else mark();
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "yes" : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function hasBinding(node: TwcoreElementNode): boolean {
  return Boolean(node.binding);
}

/** Top-level elements of a profile, skipping a redundant depth-0 resource root. */
function topElements(tree: TwcoreElementNode[]): TwcoreElementNode[] {
  if (tree.length === 1 && (tree[0].depth ?? 0) === 0) {
    return tree[0].children ?? [];
  }
  return tree;
}

/** Container element keys to expand so a matched field becomes visible. */
function ancestorElementKeys(artifactKey: string, id: string): string[] {
  const parts = id.split(".");
  const keys: string[] = [];
  let acc = "";
  parts.forEach((part, i) => {
    acc = i === 0 ? part : `${acc}.${part}`;
    if (acc.includes(".") && acc !== id) keys.push(`el:${artifactKey}:${acc}`);
  });
  return keys;
}

// ── Address-bar autocomplete helpers ────────────────────────────────────────

/** Split the address bar into trimmed segments; the last is the one being typed
 *  (kept even when empty, e.g. a trailing " / "). */
function parsePathSegments(raw: string): string[] {
  return raw.split("/").map((s) => s.trim());
}

/** Flatten an element tree into a unique, depth-first list of element ids/paths. */
function flattenElementIds(tree: TwcoreElementNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TwcoreElementNode[]) => {
    for (const n of nodes) {
      const id = elementKey(n);
      if (id) out.push(id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return Array.from(new Set(out));
}

/** Prefix matches first, then substring; case-insensitive; capped. */
function rankSuggestions(candidates: string[], query: string, cap = 40): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, cap);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const c of candidates) {
    const lc = c.toLowerCase();
    if (lc.startsWith(q)) starts.push(c);
    else if (lc.includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, cap);
}

function requirementBadges(node: TwcoreElementNode): JSX.Element {
  return (
    <>
      {node.prohibited ? (
        <span className="badge badge--bad">Prohibited</span>
      ) : node.required ? (
        <span className="badge badge--ok">Required</span>
      ) : (
        <span className="badge badge--muted">Optional</span>
      )}
      {node.must_support && <span className="badge badge--warn">Must support</span>}
      {node.binding_strength && <span className="badge badge--muted">{node.binding_strength}</span>}
    </>
  );
}

function cleanPreviewParams() {
  const url = new URL(window.location.href);
  ["twcore_preview", "twcore_source"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---------------------------------------------------------------------------
// Root modal
// ---------------------------------------------------------------------------

export function IgPreviewModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [elementSource, setElementSource] = useState<ElementSource>(() =>
    new URLSearchParams(window.location.search).get("twcore_source") === "snapshot"
      ? "snapshot"
      : "differential",
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightKey, setHighlightKey] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [pathCrumbs, setPathCrumbs] = useState<Crumb[]>([]);
  const [pathError, setPathError] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("twcore_preview", "1");
    url.searchParams.set("twcore_source", elementSource);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [elementSource]);

  // Clear the field highlight after it has had a moment to draw attention.
  useEffect(() => {
    if (!highlightKey) return;
    const t = setTimeout(() => setHighlightKey(""), 2600);
    return () => clearTimeout(t);
  }, [highlightKey]);

  const { data, isPending, isError, error } = useQuery({
    queryKey: qk.modulePreview("twcore", { mode: "navigator" }),
    queryFn: () =>
      api.get<TwcorePreviewResult>("/admin/api/modules/ig/preview?mode=navigator"),
    placeholderData: keepPreviousData,
  });

  const searchParams = { mode: "search", q: searchTerm, element_source: elementSource };
  const search = useQuery({
    queryKey: qk.modulePreview("twcore", searchParams),
    queryFn: () =>
      api.get<TwcoreSearchResult>(
        `/admin/api/modules/ig/preview?${new URLSearchParams(searchParams).toString()}`,
      ),
    enabled: Boolean(searchTerm),
    placeholderData: keepPreviousData,
  });

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Expand-only (used by the single-child auto-expand effects); never collapses.
  const expand = useCallback((key: string) => {
    setExpanded((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  function clearSearch() {
    setSearchTerm("");
    setSearchInput("");
  }

  // Walk a list of crumbs: expand every container along the way, highlight the
  // deepest hop, and mirror the canonical path back into the address bar.
  const locate = useCallback((crumbs: Crumb[]) => {
    const keys: string[] = [];
    const tokens: string[] = [];
    let highlight = "";
    for (const c of crumbs) {
      if (c.kind === "res") {
        keys.push(`res:${c.resourceName}`);
        highlight = `res:${c.resourceName}`;
        tokens.push(c.resourceName);
      } else if (c.kind === "prof") {
        keys.push(`prof:${c.artifactKey}`);
        highlight = `prof:${c.artifactKey}`;
        tokens.push(c.label);
      } else {
        keys.push(...ancestorElementKeys(c.artifactKey ?? "", c.elementId ?? ""));
        highlight = `el:${c.artifactKey}:${c.elementId}`;
        tokens.push(c.elementId ?? "");
      }
    }
    setExpanded((current) => {
      const next = new Set(current);
      keys.forEach((k) => next.add(k));
      return next;
    });
    setHighlightKey(highlight);
    setPathCrumbs(crumbs);
    setPathInput(tokens.join(" / "));
    setPathError("");
    setSearchTerm("");
    setSearchInput("");
  }, []);

  function jumpToField(row: TwcoreFieldResult) {
    const id = elementKey(row);
    const base = row.base_type ?? "";
    locate([
      { kind: "res", label: base, resourceName: base },
      {
        kind: "prof",
        label: row.artifact_title || row.artifact_id || row.artifact_key,
        resourceName: base,
        artifactKey: row.artifact_key,
      },
      { kind: "el", label: id, resourceName: base, artifactKey: row.artifact_key, elementId: id },
    ]);
  }

  function jumpToProfile(row: TwcoreArtifactRow) {
    if (!row.artifact_key) return;
    const base = row.base_type ?? "";
    locate([
      { kind: "res", label: base, resourceName: base },
      { kind: "prof", label: artifactDisplay(row), resourceName: base, artifactKey: row.artifact_key },
    ]);
  }

  // Address-bar navigation: parse "Resource / Profile / element.path" and jump.
  function navigatePath(raw: string) {
    const segs = raw.split("/").map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0) return;
    const resSeg = segs[0].toLowerCase();
    const resource = profileTree.find(
      (r) => r.resource_name.toLowerCase() === resSeg || r.label.toLowerCase() === resSeg,
    );
    if (!resource) {
      setPathError(`No resource matching “${segs[0]}”.`);
      return;
    }
    const crumbs: Crumb[] = [
      { kind: "res", label: resource.resource_name, resourceName: resource.resource_name },
    ];
    if (segs[1]) {
      const token = segs[1].toLowerCase();
      const prof = resource.profiles.find((p) =>
        [p.artifact_id, p.artifact_key, p.name, p.title].some((v) => v && v.toLowerCase() === token),
      );
      if (!prof) {
        locate(crumbs);
        setPathError(`No profile “${segs[1]}” under ${resource.resource_name}.`);
        return;
      }
      crumbs.push({
        kind: "prof",
        label: profileToken(prof),
        resourceName: resource.resource_name,
        artifactKey: prof.artifact_key,
      });
      if (segs[2]) {
        crumbs.push({
          kind: "el",
          label: segs[2],
          resourceName: resource.resource_name,
          artifactKey: prof.artifact_key,
          elementId: segs[2],
        });
      }
    }
    locate(crumbs);
  }

  function close() {
    cleanPreviewParams();
    onClose();
  }

  const profileTree = data?.profile_tree ?? [];

  // ── Address-bar autocomplete ──────────────────────────────────────────────
  // Segment-aware completion for the "Go to path" bar: Resource → Profile →
  // element. Resource/Profile candidates come from profile_tree (already loaded);
  // element candidates are fetched lazily for the resolved profile.
  const [pathFocused, setPathFocused] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const acItemRef = useRef<HTMLLIElement>(null);

  const pathSegs = parsePathSegments(pathInput);
  const acLevel = Math.max(pathSegs.length - 1, 0); // 0=resource, 1=profile, 2=element
  const activeText = pathSegs[acLevel] ?? "";
  const leadingSegs = pathSegs.slice(0, acLevel);

  // Resolve the leading segments the same way navigatePath() does (exact match).
  const acResource = leadingSegs[0]
    ? profileTree.find(
        (r) =>
          r.resource_name.toLowerCase() === leadingSegs[0].toLowerCase() ||
          r.label.toLowerCase() === leadingSegs[0].toLowerCase(),
      )
    : undefined;
  const acProfile =
    acResource && leadingSegs[1]
      ? acResource.profiles.find((p) =>
          [p.artifact_id, p.artifact_key, p.name, p.title].some(
            (v) => v && v.toLowerCase() === leadingSegs[1].toLowerCase(),
          ),
        )
      : undefined;

  const wantElements = acLevel === 2 && Boolean(acProfile?.artifact_key);
  const elemParams = useMemo(
    () => ({
      mode: "artifact_tree",
      artifact_key: acProfile?.artifact_key ?? "",
      element_source: elementSource,
      per_page: "400",
    }),
    [acProfile?.artifact_key, elementSource],
  );
  const elemQuery = useQuery({
    queryKey: qk.modulePreview("twcore", elemParams),
    queryFn: () =>
      api.get<TwcorePreviewResult>(
        `/admin/api/modules/ig/preview?${new URLSearchParams(elemParams).toString()}`,
      ),
    enabled: pathFocused && wantElements,
    placeholderData: keepPreviousData,
  });

  const acCandidates: string[] =
    acLevel === 0
      ? profileTree.map((r) => r.resource_name)
      : acLevel === 1 && acResource
        ? acResource.profiles.map((p) => profileToken(p))
        : acLevel === 2 && acProfile
          ? flattenElementIds(topElements(elemQuery.data?.element_tree ?? []))
          : [];
  const acSuggestions = rankSuggestions(acCandidates, activeText);
  const acLoading = wantElements && elemQuery.isFetching && acSuggestions.length === 0;
  const acOpen =
    pathFocused &&
    (acLoading ||
      (acSuggestions.length > 0 &&
        !(acSuggestions.length === 1 &&
          acSuggestions[0].toLowerCase() === activeText.toLowerCase())));

  // Keep the highlighted suggestion in view while arrow-keying a long list.
  useEffect(() => {
    if (acOpen) acItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [acIndex, acOpen]);

  function acAccept(candidate: string) {
    const segs = [...leadingSegs, candidate];
    if (acLevel >= 2) {
      // Element is the deepest hop — fill it and navigate immediately.
      const value = segs.join(" / ");
      setPathInput(value);
      setPathFocused(false);
      navigatePath(value);
    } else {
      // Resource/Profile — append a separator and keep completing the next hop.
      setPathInput(segs.join(" / ") + " / ");
      setAcIndex(0);
      pathInputRef.current?.focus();
    }
  }

  function onPathKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!acOpen || acSuggestions.length === 0) return; // let the form submit
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAcIndex((i) => Math.min(i + 1, acSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAcIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      acAccept(acSuggestions[Math.min(acIndex, acSuggestions.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setPathFocused(false);
    }
  }

  return (
    <Modal title="TWCore IG - data preview" onClose={close} workspace>
      <div className="twctree">
        <div className="twctree__toolbar">
          <form
            className="twctree__search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchTerm(searchInput.trim());
            }}
          >
            <input
              type="text"
              placeholder="Search fields & profiles (path, description, profile name)"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <button type="submit" className="btn btn--sm">Search</button>
            {searchTerm && (
              <button type="button" className="btn btn--sm" onClick={clearSearch}>
                Clear
              </button>
            )}
          </form>

          <div className="twctree__source" role="group" aria-label="Element source">
            <button
              type="button"
              className={`btn btn--sm ${elementSource === "differential" ? "btn--active" : ""}`}
              onClick={() => setElementSource("differential")}
              title="Only the elements TWCore constrains (must-support / bindings / cardinality)"
            >
              Key fields
            </button>
            <button
              type="button"
              className={`btn btn--sm ${elementSource === "snapshot" ? "btn--active" : ""}`}
              onClick={() => setElementSource("snapshot")}
              title="Every FHIR element, including inherited ones"
            >
              Full fields
            </button>
          </div>
        </div>

        <div className="twctree__meta">
          <span>{(data?.counts?.profile_resources ?? profileTree.length).toLocaleString()} resources</span>
          <span>{(data?.counts?.profiles ?? 0).toLocaleString()} profiles</span>
          <span>{(data?.counts?.codesystems ?? 0).toLocaleString()} CodeSystems</span>
        </div>

        <div className="twctree__pathbar">
          <span className="twctree__pathbar-icon" aria-hidden="true">🗂</span>
          {pathCrumbs.length > 0 && (
            <div className="twctree__crumbs">
              {pathCrumbs.map((c, i) => (
                <span className="twctree__crumb-wrap" key={`${c.kind}-${i}`}>
                  {i > 0 && <span className="twctree__crumb-sep">›</span>}
                  <button
                    type="button"
                    className="twctree__crumb"
                    onClick={() => locate(pathCrumbs.slice(0, i + 1))}
                    title="Go to this level"
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            className="twctree__pathform"
            onSubmit={(e) => {
              e.preventDefault();
              navigatePath(pathInput);
            }}
          >
            <div className="twctree__ac-wrap">
              <input
                ref={pathInputRef}
                type="text"
                className="twctree__pathinput"
                placeholder="Go to path — e.g. Patient / TWCorePatient / Patient.gender"
                value={pathInput}
                role="combobox"
                aria-expanded={acOpen}
                aria-autocomplete="list"
                autoComplete="off"
                onFocus={() => setPathFocused(true)}
                onBlur={() => setPathFocused(false)}
                onKeyDown={onPathKeyDown}
                onChange={(e) => {
                  setPathInput(e.target.value);
                  setAcIndex(0);
                  setPathFocused(true);
                  if (pathError) setPathError("");
                }}
              />
              {acOpen && (
                <ul className="twctree__ac" role="listbox">
                  {acLoading && <li className="twctree__ac-status">Loading fields…</li>}
                  {acSuggestions.map((s, i) => (
                    <li
                      key={s}
                      ref={i === acIndex ? acItemRef : undefined}
                      role="option"
                      aria-selected={i === acIndex}
                      className={`twctree__ac-item ${i === acIndex ? "is-active" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setAcIndex(i)}
                      onClick={() => acAccept(s)}
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="submit" className="btn btn--sm">Go</button>
          </form>
          {pathError && <span className="twctree__path-error">{pathError}</span>}
        </div>

        {isPending ? (
          <div className="muted twctree__status">Loading preview...</div>
        ) : isError ? (
          <div className="error-box twctree__status">
            Preview failed: {error instanceof ApiError ? (error.detail || error.message) : String(error)}
          </div>
        ) : data?.message ? (
          <div className="banner banner--warn twctree__status">{data.message}</div>
        ) : searchTerm ? (
          <SearchResults
            term={searchTerm}
            result={search.data}
            isFetching={search.isFetching}
            isError={search.isError}
            onSelectField={jumpToField}
            onSelectProfile={jumpToProfile}
          />
        ) : profileTree.length === 0 ? (
          <div className="muted twctree__status">No profiles loaded.</div>
        ) : (
          <div className="twctree__body" role="tree">
            {profileTree.map((resource) => (
              <ResourceGroupNode
                key={resource.resource_name}
                resource={resource}
                elementSource={elementSource}
                expanded={expanded}
                highlightKey={highlightKey}
                onToggle={toggle}
                onExpand={expand}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Search results  (server-side field + profile matches)
// ---------------------------------------------------------------------------

function SearchResults({
  term,
  result,
  isFetching,
  isError,
  onSelectField,
  onSelectProfile,
}: {
  term: string;
  result?: TwcoreSearchResult;
  isFetching: boolean;
  isError: boolean;
  onSelectField: (row: TwcoreFieldResult) => void;
  onSelectProfile: (row: TwcoreArtifactRow) => void;
}): JSX.Element {
  const fields = result?.field_results ?? [];
  const profiles = (result?.rows ?? []).filter((r) => r.resource_type === "StructureDefinition");

  if (isError) {
    return <div className="error-box twctree__status">Search failed.</div>;
  }
  if (isFetching && !result) {
    return <div className="muted twctree__status">Searching “{term}”...</div>;
  }
  if (fields.length === 0 && profiles.length === 0) {
    return <div className="muted twctree__status">No matches for “{term}”.</div>;
  }

  return (
    <div className="twctree__body twctree__results">
      <section className="twctree__result-section">
        <div className="twctree__result-head">
          <h4>Fields</h4>
          <span className="muted small">
            {(result?.field_results_total ?? fields.length).toLocaleString()} matches
            {(result?.field_results_total ?? 0) > fields.length ? ` (showing ${fields.length})` : ""}
          </span>
        </div>
        {fields.length === 0 ? (
          <div className="muted twctree__leaf-msg">No field matches.</div>
        ) : (
          fields.map((row) => (
            <button
              type="button"
              className="twctree__result"
              key={`${row.artifact_key}-${elementKey(row)}`}
              onClick={() => onSelectField(row)}
            >
              <span className="twctree__result-top">
                <span className="twctree__result-path">{row.path}</span>
                {row.cardinality && <span className="twctree__card">{row.cardinality}</span>}
                <span className="twctree__badges">{requirementBadges(row)}</span>
              </span>
              <span className="twctree__result-meta">
                {row.artifact_title || row.artifact_id}
                {row.base_type ? ` · ${row.base_type}` : ""}
                {row.binding ? " · has ValueSet" : ""}
              </span>
              {row.short && <span className="twctree__result-short">{row.short}</span>}
            </button>
          ))
        )}
      </section>

      <section className="twctree__result-section">
        <div className="twctree__result-head">
          <h4>Profiles</h4>
          <span className="muted small">{profiles.length.toLocaleString()} matches</span>
        </div>
        {profiles.length === 0 ? (
          <div className="muted twctree__leaf-msg">No profile matches.</div>
        ) : (
          profiles.map((row) => (
            <button
              type="button"
              className="twctree__result"
              key={row.artifact_key}
              onClick={() => onSelectProfile(row)}
            >
              <span className="twctree__result-top">
                <span className="twctree__result-path">{artifactDisplay(row)}</span>
                {row.base_type && <span className="badge badge--muted">{row.base_type}</span>}
              </span>
              {row.description && <span className="twctree__result-short">{row.description}</span>}
            </button>
          ))
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resource group  (Patient / Observation / ...)
// ---------------------------------------------------------------------------

function ResourceGroupNode({
  resource,
  elementSource,
  expanded,
  highlightKey,
  onToggle,
  onExpand,
}: {
  resource: TwcoreProfileResourceNode;
  elementSource: ElementSource;
  expanded: Set<string>;
  highlightKey: string;
  onToggle: (key: string) => void;
  onExpand: (key: string) => void;
}): JSX.Element {
  const key = `res:${resource.resource_name}`;
  const isOpen = expanded.has(key);
  const isHit = highlightKey === key;

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isHit) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isHit]);

  // If a resource holds a single profile, opening it reveals that profile too.
  const onlyProfileKey =
    resource.profiles.length === 1 ? `prof:${resource.profiles[0].artifact_key}` : "";
  useEffect(() => {
    if (isOpen && onlyProfileKey) onExpand(onlyProfileKey);
  }, [isOpen, onlyProfileKey, onExpand]);

  return (
    <div className="twctree__node" role="treeitem" aria-expanded={isOpen}>
      <div ref={rowRef} className={`twctree__row twctree__row--resource ${isHit ? "twctree__row--hit" : ""}`}>
        <button type="button" className="twctree__rowmain" onClick={() => onToggle(key)}>
          <span className="twctree__caret">{isOpen ? "▾" : "▸"}</span>
          <span className="twctree__label">{resource.label}</span>
          <span className="twctree__count">{resource.profile_count.toLocaleString()} profiles</span>
        </button>
        <CopyPathButton path={resource.resource_name} />
      </div>
      {isOpen && (
        <div className="twctree__children">
          {resource.profiles.map((profile) => (
            <ProfileNode
              key={profile.artifact_key}
              profile={profile}
              resourceName={resource.resource_name}
              elementSource={elementSource}
              expanded={expanded}
              highlightKey={highlightKey}
              onToggle={onToggle}
              onExpand={onExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile  (TWCorePatient ...)  — lazily loads its element tree
// ---------------------------------------------------------------------------

function ProfileNode({
  profile,
  resourceName,
  elementSource,
  expanded,
  highlightKey,
  onToggle,
  onExpand,
}: {
  profile: TwcoreArtifactRow;
  resourceName: string;
  elementSource: ElementSource;
  expanded: Set<string>;
  highlightKey: string;
  onToggle: (key: string) => void;
  onExpand: (key: string) => void;
}): JSX.Element {
  const artifactKey = profile.artifact_key ?? "";
  const key = `prof:${artifactKey}`;
  const isOpen = expanded.has(key);
  const isHit = highlightKey === key;
  const pathPrefix = `${resourceName} / ${profileToken(profile)}`;

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isHit) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isHit]);

  const params = useMemo(
    () => ({
      mode: "artifact_tree",
      artifact_key: artifactKey,
      element_source: elementSource,
      per_page: "400",
    }),
    [artifactKey, elementSource],
  );

  const { data, isFetching, isError } = useQuery({
    queryKey: qk.modulePreview("twcore", params),
    queryFn: () =>
      api.get<TwcorePreviewResult>(
        `/admin/api/modules/ig/preview?${new URLSearchParams(params).toString()}`,
      ),
    enabled: isOpen,
    placeholderData: keepPreviousData,
  });

  const elements = topElements(data?.element_tree ?? []);

  // A profile whose differential has a single top-level field opens straight to it.
  const onlyElKey = elements.length === 1 ? `el:${artifactKey}:${elementKey(elements[0])}` : "";
  useEffect(() => {
    if (isOpen && onlyElKey) onExpand(onlyElKey);
  }, [isOpen, onlyElKey, onExpand]);

  return (
    <div className="twctree__node" role="treeitem" aria-expanded={isOpen}>
      <div ref={rowRef} className={`twctree__row twctree__row--profile ${isHit ? "twctree__row--hit" : ""}`}>
        <button type="button" className="twctree__rowmain" onClick={() => onToggle(key)}>
          <span className="twctree__caret">{isOpen ? "▾" : "▸"}</span>
          <span className="twctree__label">{artifactDisplay(profile)}</span>
          {profile.base_type && <span className="badge badge--muted">{profile.base_type}</span>}
          <span className="twctree__count">{(profile.child_count ?? 0).toLocaleString()} fields</span>
        </button>
        <CopyPathButton path={pathPrefix} />
      </div>
      {isOpen && (
        <div className="twctree__children">
          {isFetching && !data ? (
            <div className="muted twctree__leaf-msg">Loading fields...</div>
          ) : isError ? (
            <div className="error-box twctree__leaf-msg">Failed to load fields.</div>
          ) : elements.length === 0 ? (
            <div className="muted twctree__leaf-msg">
              No {elementSource === "differential" ? "constrained" : ""} fields.
            </div>
          ) : (
            elements.map((el) => (
              <ElementNode
                key={elementKey(el)}
                artifactKey={artifactKey}
                pathPrefix={pathPrefix}
                node={el}
                expanded={expanded}
                highlightKey={highlightKey}
                onToggle={onToggle}
                onExpand={onExpand}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Element  (recursive field)  — inline detail card + ValueSet sub-node
// ---------------------------------------------------------------------------

function ElementNode({
  artifactKey,
  pathPrefix,
  node,
  expanded,
  highlightKey,
  onToggle,
  onExpand,
}: {
  artifactKey: string;
  pathPrefix: string;
  node: TwcoreElementNode;
  expanded: Set<string>;
  highlightKey: string;
  onToggle: (key: string) => void;
  onExpand: (key: string) => void;
}): JSX.Element {
  const id = elementKey(node);
  const children = node.children ?? [];
  const binding = hasBinding(node);
  const expandable = children.length > 0 || binding;

  const nodeKey = `el:${artifactKey}:${id}`;
  const detailKey = `eld:${artifactKey}:${id}`;
  const bindingKey = `bind:${artifactKey}:${id}`;
  const isOpen = expanded.has(nodeKey);
  const detailOpen = expanded.has(detailKey);
  const isHit = highlightKey === nodeKey;
  const label = node.path ? node.path.split(".").pop() : id;
  const myPath = `${pathPrefix} / ${id}`;

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isHit) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isHit]);

  // Drilling into a field that has just one sub-field opens it automatically.
  const onlyChildKey = children.length === 1 ? `el:${artifactKey}:${elementKey(children[0])}` : "";
  useEffect(() => {
    if (isOpen && onlyChildKey) onExpand(onlyChildKey);
  }, [isOpen, onlyChildKey, onExpand]);

  return (
    <div className="twctree__node" role="treeitem" aria-expanded={expandable ? isOpen : undefined}>
      <div ref={rowRef} className={`twctree__row twctree__row--element ${isHit ? "twctree__row--hit" : ""}`}>
        <button
          type="button"
          className="twctree__caret twctree__caret--btn"
          onClick={() => expandable && onToggle(nodeKey)}
          disabled={!expandable}
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {expandable ? (isOpen ? "▾" : "▸") : "·"}
        </button>
        <button type="button" className="twctree__element-main" onClick={() => onToggle(detailKey)}>
          <span className="twctree__element-head">
            <span className="twctree__label">{label}</span>
            <span className="twctree__path muted">{node.path}</span>
            {node.cardinality && <span className="twctree__card">{node.cardinality}</span>}
            {node.type && <span className="twctree__type">{node.type}</span>}
          </span>
          <span className="twctree__badges">{requirementBadges(node)}</span>
        </button>
        {binding && (
          <button
            type="button"
            className="btn btn--sm twctree__vs-btn"
            onClick={() => onToggle(bindingKey)}
          >
            {expanded.has(bindingKey) ? "Hide values" : "ValueSet"}
          </button>
        )}
        <CopyPathButton path={myPath} />
      </div>

      {detailOpen && <ElementDetail node={node} />}

      {(isOpen || expanded.has(bindingKey)) && (
        <div className="twctree__children">
          {binding && expanded.has(bindingKey) && (
            <BindingNode valueSetUrl={node.binding ?? ""} />
          )}
          {isOpen &&
            children.map((child) => (
              <ElementNode
                key={elementKey(child)}
                artifactKey={artifactKey}
                pathPrefix={pathPrefix}
                node={child}
                expanded={expanded}
                highlightKey={highlightKey}
                onToggle={onToggle}
                onExpand={onExpand}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function ElementDetail({ node }: { node: TwcoreElementNode }): JSX.Element {
  const facts: Array<[string, string]> = [
    ["Type", text(node.type)],
    ["Short", text(node.short)],
    ["Definition", text(node.definition)],
    ["Comment", text(node.comment)],
    ["Requirements", text(node.requirements)],
  ].filter(([, v]) => v) as Array<[string, string]>;
  if (node.fixed_value) facts.push([node.fixed_kind || "Fixed", node.fixed_value]);
  if (node.binding) {
    facts.push(["Binding", node.binding]);
    if (node.binding_description) facts.push(["Binding info", node.binding_description]);
  }
  const constraints = node.constraints ?? [];
  return (
    <div className="twctree__detail">
      {facts.length === 0 && constraints.length === 0 ? (
        <div className="muted small">No extra detail.</div>
      ) : (
        <>
          {facts.map(([k, v]) => (
            <div className="twctree__detail-fact" key={k}>
              <span className="twctree__detail-key">{k}</span>
              <span className="twctree__detail-val">{v}</span>
            </div>
          ))}
          {constraints.length > 0 && (
            <div className="twctree__detail-constraints">
              {constraints.map((c) => (
                <div className="twctree__constraint" key={`${c.key}-${c.expression}`}>
                  <strong>{c.key}</strong>
                  <span>{c.human}</span>
                  {c.expression && <code>{c.expression}</code>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ValueSet binding  — lazily loads allowed codes
// ---------------------------------------------------------------------------

const VALUESET_PAGE_SIZE = 100;

// Row types that describe a pointer/rule rather than a concrete pickable code.
const NOTE_ROW_TYPES = new Set([
  "external ValueSet",
  "system include",
  "ValueSet reference",
  "filter rule",
]);

function BindingNode({ valueSetUrl }: { valueSetUrl: string }): JSX.Element {
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [valueSetUrl]);

  const params = useMemo(
    () => ({
      mode: "valueset",
      value_set_url: valueSetUrl,
      page: String(page),
      per_page: String(VALUESET_PAGE_SIZE),
    }),
    [valueSetUrl, page],
  );

  const { data, isFetching, isError } = useQuery({
    queryKey: qk.modulePreview("twcore", params),
    queryFn: () =>
      api.get<TwcorePreviewResult>(
        `/admin/api/modules/ig/preview?${new URLSearchParams(params).toString()}`,
      ),
    enabled: Boolean(valueSetUrl),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / VALUESET_PAGE_SIZE));

  // Some rows aren't concrete pickable codes — they're pointers/rules that can't
  // be enumerated here (an external/core-FHIR ValueSet, a whole external code
  // system, a referenced ValueSet, or a terminology filter). Show those as notes.
  const codeRows = rows.filter((r) => r.code && !NOTE_ROW_TYPES.has(r.row_type ?? ""));
  const noteRows = rows.filter((r) => !r.code || NOTE_ROW_TYPES.has(r.row_type ?? ""));

  return (
    <div className="twctree__valueset">
      <div className="twctree__vs-head">
        <span className="twctree__vs-title">Allowed values</span>
        <span className="muted small">
          {codeRows.length > 0 ? `${total.toLocaleString()} codes` : "Reference only"}
        </span>
      </div>
      <div className="twctree__vs-url muted small">ValueSet: {valueSetUrl}</div>
      {isFetching && !data ? (
        <div className="muted twctree__leaf-msg">Loading values...</div>
      ) : isError ? (
        <div className="error-box twctree__leaf-msg">Failed to load values.</div>
      ) : rows.length === 0 ? (
        <div className="muted twctree__leaf-msg">No codes.</div>
      ) : (
        <>
          {noteRows.length > 0 && (
            <div className="twctree__vs-notes">
              {noteRows.map((row, index) => (
                <div className="twctree__vs-note" key={`note-${index}`}>
                  {row.row_type && <span className="badge badge--muted">{row.row_type}</span>}
                  <span className="twctree__vs-note-text">
                    {row.meaning ||
                      row.display ||
                      "Codes are defined outside the TWCore package and can’t be listed here."}
                  </span>
                  {row.system && <span className="muted small">{row.system}</span>}
                </div>
              ))}
            </div>
          )}
          {codeRows.length > 0 && (
            <div className="twctree__codes">
              {codeRows.map((row, index) => (
                <div className="twctree__code" key={`${row.system}-${row.code}-${index}`}>
                  <span className="twctree__code-key">{row.code}</span>
                  <span className="twctree__code-body">
                    <span className="twctree__code-display">{row.display || row.meaning || row.definition}</span>
                    {row.system && <span className="muted small">{row.system}</span>}
                    {row.properties && <span className="muted small">{row.properties}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {totalPages > 1 && (
        <div className="twctree__vs-pager">
          <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span className="muted small">{page} / {totalPages}</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

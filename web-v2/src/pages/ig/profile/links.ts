// Shared URL contract for the IG profile page (used by the IG drawer, artifact browser and MCP pages).

/** Route pattern registered in App.tsx (relative to the /admin/ basename). */
export const PROFILE_ROUTE = "fhir/ig/:packageId/:version/profile/:artifactId";

/** Link to one profile (StructureDefinition artifact id) of an installed IG package. */
export function profileHref(packageId: string, version: string, artifactId: string): string {
  return `/fhir/ig/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/profile/${encodeURIComponent(artifactId)}`;
}

/** Deep link into one element of a profile's element tree (`?el=<element id>`). */
export function profileElementHref(packageId: string, version: string, artifactId: string, elementId: string): string {
  return `${profileHref(packageId, version, artifactId)}?el=${encodeURIComponent(elementId)}`;
}

/**
 * IG 套件庫 with one IG's detail drawer open (`?open=<package>@<version>`); `fixDeps`
 * opens that IG's missing-dependency dialog instead (`&fix_deps=1`). Read by IgPage (detail/detailMeta.tsx).
 */
export function igHref(packageId: string, version: string, opts: { fixDeps?: boolean } = {}): string {
  const sp = new URLSearchParams({ open: `${packageId}@${version}` });
  if (opts.fixDeps) sp.set("fix_deps", "1");
  return `/fhir/ig?${sp.toString()}`;
}

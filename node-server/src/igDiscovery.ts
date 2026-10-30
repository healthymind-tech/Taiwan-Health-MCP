/**
 * ISSUES_v17 R1-4 — find the IG (and its Bundle profiles) a conversion target names, from Chinese
 * names, English names or short names: 「轉為健保事前審查 Bundle」→ tw.gov.mohw.nhi.pas,
 * 「TWCM」/「中醫」→ the Chinese-medicine IG. IG-agnostic: every term comes from the installed
 * package itself — its title (and the short names in its brackets: 「(TW Core IG)」), package id
 * segments, and its ImplementationGuide resource's name / title / description.
 *
 * Scoring: short names / package-id segments matched as whole words (strong), Chinese character
 * bigrams shared with the title and description (graded), English words shared with them. Generic
 * words of a conversion request (轉為, Bundle, FHIR, 實作指引, 臺灣 …) carry no weight.
 */

type Json = Record<string, any>;

export interface IgText {
  packageId: string;
  version: string;
  title: string | null;
  installOrigin: string | null;
  isDefault: boolean;
  /** ImplementationGuide.name / title / description of the package (when installed). */
  igName?: string | null;
  igTitle?: string | null;
  igDescription?: string | null;
}

export interface IgMatch {
  packageId: string;
  version: string;
  title: string | null;
  score: number;
  matched: string[];
}

const GENERIC = new Set([
  "bundle", "fhir", "ig", "implementation", "guide", "profile", "resource", "resources", "r4", "hl7", "the", "a", "an", "of", "for", "to", "and",
  "tw", "taiwan", "gov", "mohw", "org", "fhir.org", "core",
]);
const GENERIC_ZH = ["轉換為", "轉換成", "轉為", "轉成", "轉換", "產生", "建立", "請將", "請", "實作指引", "指引", "臺灣", "台灣", "格式", "文件", "資料", "單張", "的", "之"];

const nfkc = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/臺/gu, "台");

/** Latin words (≥ 2 letters / digits) of a text. */
function words(s: string): string[] {
  return (nfkc(s).match(/[a-z][a-z0-9]+|\d[a-z0-9]*[a-z][a-z0-9]*/gu) ?? []).filter((w) => !GENERIC.has(w));
}

/** Chinese character bigrams of a text, generic request words removed. */
function bigrams(s: string): Set<string> {
  let t = nfkc(s);
  for (const g of GENERIC_ZH) t = t.split(nfkc(g)).join(" ");
  const out = new Set<string>();
  for (const run of t.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** Short names of an IG: bracketed parts of its title, package-id segments, IG.name, all-caps tokens. */
export function shortNames(ig: IgText): string[] {
  const out = new Set<string>();
  for (const m of (ig.title ?? "").matchAll(/[（(]([^）)]+)[）)]/gu)) for (const w of words(m[1])) out.add(w);
  for (const seg of ig.packageId.split(".")) if (!GENERIC.has(seg.toLowerCase()) && seg.length >= 2) out.add(seg.toLowerCase());
  if (ig.igName) for (const w of words(ig.igName)) out.add(w);
  for (const w of [...out]) {
    // TWPAS / TWNHIBASE / TWCM: also without the country prefix (PAS, NHIBASE, CM) and the package segment joined (nhi.pas → nhipas)
    if (/^tw[a-z]{2,}/u.test(w)) out.add(w.slice(2));
  }
  out.add(ig.packageId.toLowerCase().split(".").filter((s) => !GENERIC.has(s)).join(""));
  return [...out].filter((w) => w.length >= 2);
}

/** Rank installed IGs for a free-text conversion target / name. */
export function matchIgs(queryText: string, igs: readonly IgText[], limit = 5): IgMatch[] {
  const qWords = new Set(words(queryText));
  const qJoined = nfkc(queryText).replace(/[^a-z0-9]/gu, "");
  const qBi = bigrams(queryText);
  // document frequency of each bigram over the distinct installed packages: a bigram many IGs share (病歷, 檢驗) says less
  const df = new Map<string, number>();
  const seenPkg = new Set<string>();
  for (const ig of igs) {
    if (seenPkg.has(ig.packageId)) continue;
    seenPkg.add(ig.packageId);
    for (const b of bigrams([ig.title, ig.igTitle, ig.igDescription].filter(Boolean).join(" "))) df.set(b, (df.get(b) ?? 0) + 1);
  }
  const out: IgMatch[] = [];
  for (const ig of igs) {
    const matched: string[] = [];
    let score = 0;
    for (const s of shortNames(ig)) {
      if (qWords.has(s) || (s.length >= 4 && qJoined.includes(s))) {
        score += 3;
        matched.push(s);
      }
    }
    const text = [ig.title, ig.igTitle, ig.igDescription].filter(Boolean).join(" ");
    const tBi = bigrams(text);
    if (qBi.size && tBi.size) {
      const shared = [...qBi].filter((b) => tBi.has(b));
      if (shared.length) {
        const w = shared.reduce((acc, b) => acc + 1 / Math.sqrt(df.get(b) ?? 1), 0);
        score += (2 * w) / qBi.size + 0.2 * w;
        matched.push(...shared.slice(0, 6));
      }
    }
    const tWords = new Set(words(text));
    const sharedW = [...qWords].filter((w) => tWords.has(w) && !matched.includes(w));
    if (sharedW.length) {
      score += 0.5 * sharedW.length;
      matched.push(...sharedW.slice(0, 4));
    }
    if (score <= 0.3) continue;
    // a manually installed IG outranks the same IG pulled in only as a dependency
    if (ig.installOrigin === "manual") score += 0.25;
    out.push({ packageId: ig.packageId, version: ig.version, title: ig.title, score: Math.round(score * 100) / 100, matched });
  }
  return out.sort((a, b) => b.score - a.score || a.packageId.localeCompare(b.packageId)).slice(0, limit);
}

export type { Json };

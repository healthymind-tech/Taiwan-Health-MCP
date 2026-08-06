/*
 * URL-parameter language switching for the bilingual docs site.
 *
 *   ?lang=en      -> English build   (/en/<page>/)
 *   ?lang=zh-TW   -> 繁體中文 build  (/<page>/)
 *
 * The site is built by mkdocs-static-i18n as two static trees (zh-TW at the
 * root, English under /en/). GitHub Pages cannot route on a query string, so
 * this shim reads ?lang= client-side and redirects to the matching path. The
 * canonical per-language URLs keep working on their own, which is what search
 * indexing and deep links rely on — ?lang= is an entry point, not the address.
 *
 * The site root is derived from this script's own resolved URL rather than
 * hard-coded, so it survives a repo rename or a move to a custom domain.
 */
(function () {
  "use strict";

  var DEFAULT_LOCALE = "zh-TW";
  // Non-default locales and the path prefix each is published under.
  var PREFIXES = { en: "en/" };

  // Accept the spellings a human or a browser might realistically send.
  var ALIASES = {
    en: "en",
    "en-us": "en",
    "en-gb": "en",
    english: "en",
    zh: "zh-TW",
    "zh-tw": "zh-TW",
    "zh-hant": "zh-TW",
    "zh-hant-tw": "zh-TW",
    tw: "zh-TW",
    "zh-hans": "zh-TW",
  };

  var script = document.currentScript;
  if (!script) return;

  var params = new URLSearchParams(window.location.search);
  if (!params.has("lang")) return;

  var requested = ALIASES[String(params.get("lang")).trim().toLowerCase()];
  if (!requested) return; // unknown value: leave the page alone

  // Static assets are shared by both language trees: this script is always
  // served from "<siteRoot>javascripts/lang-switch.js", whichever language the
  // page belongs to. Resolving its URL therefore yields the site root — which
  // is why the current locale is detected from the path prefix below, not from
  // the script's own location.
  var siteRoot = new URL(script.src, window.location.href).pathname.replace(
    /javascripts\/lang-switch\.js$/,
    ""
  );

  // Page path relative to the site root, e.g. "en/deployment/" or "deployment/".
  var page = window.location.pathname.slice(siteRoot.length);

  // Identify the current locale by the prefix its tree sits behind, and strip
  // that prefix so `page` becomes locale-independent.
  var current = DEFAULT_LOCALE;
  Object.keys(PREFIXES).forEach(function (locale) {
    var prefix = PREFIXES[locale];
    if (page.slice(0, prefix.length) === prefix) {
      current = locale;
      page = page.slice(prefix.length);
    }
  });

  var langRoot = siteRoot + (PREFIXES[current] || "");

  // Drop ?lang= either way so the address bar ends up on the canonical URL and
  // a refresh cannot re-trigger the redirect.
  params.delete("lang");
  var rest = params.toString();
  var query = rest ? "?" + rest : "";

  if (requested === current) {
    window.history.replaceState({}, "", langRoot + page + query + window.location.hash);
    return;
  }

  var target = siteRoot + (PREFIXES[requested] || "") + page + query + window.location.hash;
  window.location.replace(target);
})();

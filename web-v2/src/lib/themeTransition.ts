import { flushSync } from "react-dom";
import type { MantineColorScheme } from "@mantine/core";

/**
 * Animated light/dark switching.
 *
 * - View Transitions API available: circular reveal of the new theme expanding
 *   from the toggle button (or a supplied origin). Only the colour-scheme update
 *   is captured — it is applied with flushSync inside the transition callback.
 * - Unsupported (older Firefox / Safari): a short CSS cross-fade enabled by a
 *   temporary class on <html>, removed afterwards so hovers stay instant.
 * - prefers-reduced-motion: instant switch.
 */

const DURATION = 450;
const EASING = "cubic-bezier(.4,0,.2,1)";
const FADE_CLASS = "theme-fading";
const FADE_MS = 260;

/** Selector of the visible theme toggle, used as the reveal origin for hotkeys. */
export const THEME_TOGGLE_SELECTOR = "[data-theme-toggle]";

type ViewTransitionLike = { finished: Promise<void>; ready: Promise<void>; skipTransition: () => void };
type DocWithVT = Document & { startViewTransition?: (cb: () => void) => ViewTransitionLike };

let active: ViewTransitionLike | null = null;
let fadeTimer: number | undefined;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function systemScheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveScheme(value: MantineColorScheme): "light" | "dark" {
  return value === "auto" ? systemScheme() : value;
}

function currentScheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light";
}

/** Centre of the visible theme toggle, or the top-right corner as a fallback. */
function defaultOrigin(): { x: number; y: number } {
  const els = Array.from(document.querySelectorAll<HTMLElement>(THEME_TOGGLE_SELECTOR));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: window.innerWidth - 40, y: 30 };
}

/** Temporarily cross-fade colours. Must be called in the same task as the change. */
export function crossFadeColors(): void {
  if (prefersReducedMotion()) return;
  const root = document.documentElement;
  root.classList.add(FADE_CLASS);
  window.clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => root.classList.remove(FADE_CLASS), FADE_MS + 60);
}

/**
 * Apply a colour-scheme change with an animation.
 * `apply` must perform the state update synchronously (e.g. Mantine's setColorScheme).
 */
export function switchColorScheme(
  apply: (value: MantineColorScheme) => void,
  value: MantineColorScheme,
  origin?: HTMLElement | { x: number; y: number } | null,
): void {
  const next = resolveScheme(value);
  // No visible change (e.g. dark -> auto while the OS is dark): just store it.
  if (next === currentScheme() || prefersReducedMotion()) {
    apply(value);
    return;
  }

  const doc = document as DocWithVT;
  if (typeof doc.startViewTransition !== "function") {
    crossFadeColors();
    apply(value);
    return;
  }

  // A rapid second toggle finishes the running reveal instantly.
  active?.skipTransition();

  const { x, y } =
    origin instanceof HTMLElement
      ? (() => {
          const r = origin.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()
      : origin ?? defaultOrigin();
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  const root = document.documentElement;
  root.classList.add("theme-vt");
  let transition: ViewTransitionLike;
  try {
    transition = doc.startViewTransition(() => {
      flushSync(() => apply(value));
    });
  } catch {
    root.classList.remove("theme-vt");
    apply(value);
    return;
  }
  active = transition;

  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: DURATION, easing: EASING, pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => undefined);
  transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (active === transition) active = null;
      root.classList.remove("theme-vt");
    });
}

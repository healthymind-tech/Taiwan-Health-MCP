/**
 * Array helpers that are safe for data-sized inputs.
 *
 * `target.push(...items)` passes every element as a separate call argument, and
 * V8 throws `RangeError: Maximum call stack size exceeded` once that passes
 * roughly 120k arguments (the exact limit depends on stack size). IG packages
 * routinely carry CodeSystems with hundreds of thousands of concepts, so any
 * append whose size depends on input data must go through `pushAll` instead.
 */

/** Append `items` to `target` in place (loop, no argument spreading). Returns `target`. */
export function pushAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}

/** Minimum of a numeric array without spreading it into `Math.min`. Infinity when empty. */
export function minOf(values: Iterable<number>): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

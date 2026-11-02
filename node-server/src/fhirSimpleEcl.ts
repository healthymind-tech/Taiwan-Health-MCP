/**
 * The part of SNOMED CT Expression Constraint Language a ValueSet `constraint` filter can be answered with from the
 * local is-a hierarchy: `id`, `< id`, `<< id`, brackets, AND, OR, MINUS. A member of a reference set `^ id` is unknown (no
 * refset table here), which still lets a conjunction say "no" (three-valued). An expression with anything else
 * (refinements, attributes, wildcards, cardinality, mixed operators without brackets) is not parsed: tx.fhir.org evaluates it.
 */
export type SimpleEcl =
  | { kind: "concept"; op: "self" | "descendants" | "descendantsOrSelf"; id: string }
  | { kind: "refset"; id: string }
  | { kind: "and" | "or"; items: SimpleEcl[] }
  | { kind: "minus"; left: SimpleEcl; right: SimpleEcl };

const TOKEN = /\s*(<<|<|\^|\(|\)|\d{6,18}|[A-Za-z]+)/y;

function tokenize(text: string): string[] | null {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (text.slice(at).trim() !== "") {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) return null;
    tokens.push(m[1]);
    at = TOKEN.lastIndex;
  }
  return tokens;
}

export function parseSimpleEcl(expression: string): SimpleEcl | null {
  const tokens: string[] = tokenize(expression.replace(/\|[^|]*\|/g, " ")) ?? [];
  if (!tokens.length) return null;
  let at = 0;
  const focus = (): SimpleEcl | null => {
    const t = tokens[at];
    if (t === "(") {
      at++;
      const inner = expr();
      if (!inner || tokens[at] !== ")") return null;
      at++;
      return inner;
    }
    if (t === "^") {
      at++;
      const id = tokens[at++];
      return id && /^\d+$/.test(id) ? { kind: "refset", id } : null;
    }
    const op = t === "<<" ? "descendantsOrSelf" : t === "<" ? "descendants" : "self";
    if (op !== "self") at++;
    const id = tokens[at++];
    return id && /^\d+$/.test(id) ? { kind: "concept", op, id } : null;
  };
  // ECL: a compound expression uses one operator, a mix needs brackets
  function expr(): SimpleEcl | null {
    const first = focus();
    if (!first) return null;
    const items = [first];
    let join: string | null = null;
    while (at < tokens.length && tokens[at] !== ")") {
      const word = String(tokens[at]).toUpperCase();
      if (word !== "AND" && word !== "OR" && word !== "MINUS") return null;
      if (join !== null && word !== join) return null;
      join = word;
      at++;
      const next = focus();
      if (!next) return null;
      items.push(next);
    }
    if (join === null) return first;
    if (join === "MINUS") return items.slice(1).reduce<SimpleEcl>((left, right) => ({ kind: "minus", left, right }), items[0]);
    return { kind: join === "AND" ? "and" : "or", items };
  }
  const tree = expr();
  return tree && at === tokens.length ? tree : null;
}

/** Membership of `code`; `subsumedBy(code, id)` is true for code = id, undefined when the hierarchy cannot answer. */
export async function simpleEclContains(
  ecl: SimpleEcl,
  code: string,
  subsumedBy: (code: string, ancestor: string) => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  const rec = (e: SimpleEcl): Promise<boolean | undefined> => simpleEclContains(e, code, subsumedBy);
  switch (ecl.kind) {
    case "refset":
      return undefined;
    case "concept": {
      if (ecl.op === "self") return code === ecl.id;
      const r = await subsumedBy(code, ecl.id);
      return r === true && ecl.op === "descendants" && code === ecl.id ? false : r;
    }
    case "minus": {
      const left = await rec(ecl.left);
      if (left === false) return false;
      const right = await rec(ecl.right);
      if (right === true) return false;
      return left === true && right === false ? true : undefined;
    }
    default: {
      const stop = ecl.kind === "or";
      let unknown = false;
      for (const item of ecl.items) {
        const r = await rec(item);
        if (r === undefined) unknown = true;
        else if (r === stop) return r;
      }
      return unknown ? undefined : !stop;
    }
  }
}

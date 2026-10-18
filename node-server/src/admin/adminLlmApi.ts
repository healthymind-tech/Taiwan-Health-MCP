/**
 * Admin REST for provider accounts, profiles and role bindings (/admin/api/llm/*).
 *
 *   GET    /admin/api/llm/accounts                  → { accounts, cooling }
 *   POST   /admin/api/llm/accounts                  create
 *   PATCH  /admin/api/llm/accounts/:id              update (blank api_key keeps the stored one)
 *   DELETE /admin/api/llm/accounts/:id
 *   POST   /admin/api/llm/accounts/test             draft {id?, provider, base_url, api_key, params, model?, kind?}
 *                                                    → connectivity + model list (+ a real call when a model is given)
 *   POST   /admin/api/llm/accounts/:id/models       { kind } → live model list for that role
 *   POST   /admin/api/llm/models/test               { provider_id, model, kind, params } → one model, full diagnostics
 *   GET    /admin/api/llm/routes                    → { routes, roles, stats, cooling }
 *   POST   /admin/api/llm/routes                    create
 *   PUT    /admin/api/llm/routes/:id                replace (members included)
 *   DELETE /admin/api/llm/routes/:id
 *   POST   /admin/api/llm/routes/:id/test           walk the profile as a real request would → attempt trace
 *   PUT    /admin/api/llm/roles                     { role, route_id }
 *   GET    /admin/api/llm/embedding                 → system identity + vector counts
 *   POST   /admin/api/llm/embedding/check           { provider_id, model, params, cached? } → fingerprint verdict
 *   POST   /admin/api/llm/embedding/precheck        { provider_id, model, params } → what a switch would find (no side effects)
 *   POST   /admin/api/llm/embedding/switch          { provider_id, model, params, confirm } → re-index with a new model
 *   POST   /admin/api/llm/embedding/establish       record the identity from the endpoint that made the stored vectors
 *   GET    /admin/api/llm/embedding/health      → per-member probe of the embedding role (cached 60 s; POST {fresh:true} re-probes)
 *   POST   /admin/api/llm/oauth/chatgpt/start       { name, account_id?, allow_role_use? } → { authorize_url, redirect_uri }
 *   POST   /admin/api/llm/oauth/chatgpt/complete    { callback_url } → { account_id, email }
 */

import * as adminSettings from "./adminSettings.js";
import { ProviderHttpError } from "../providers/types.js";
import { CodedProfileError, coolingDown, ProfileNotFoundError, ProfileValidationError, type ProfileKind } from "./llmProfiles.js";
import { codeFields, errorFields } from "./llmErrorCodes.js";
import { diagnoseEmbedFailure } from "./embeddingDiagnosis.js";
import { embeddingDimensions } from "./llmProfiles.js";
import * as llmProfileStats from "./llmProfileStats.js";
import {
  accountPublic,
  createAccount,
  deleteAccount,
  deleteRoute,
  getAccount,
  getRoleRoutes,
  leafFromAccount,
  listAccounts,
  listRoutes,
  planRouteDelete,
  recordAccountTest,
  routeCandidates,
  saveRoute,
  setRoleRoute,
  updateAccount,
  type AccountInput,
  type RouteInput,
} from "./llmRouting.js";

type Reply = (status: number, payload: unknown) => void;

function kindOf(v: unknown): ProfileKind {
  return v === "embedding" ? "embedding" : "analysis";
}

/** A role named by the client: only the two that exist. */
function roleOf(v: unknown): ProfileKind {
  if (v !== "analysis" && v !== "embedding") throw new ProfileValidationError(`Unknown role: ${String(v)}`);
  return v;
}

async function statsJson(): Promise<Record<string, llmProfileStats.ProfileStats>> {
  const out: Record<string, llmProfileStats.ProfileStats> = {};
  for (const [id, s] of await llmProfileStats.readProfileStats()) out[String(id)] = s;
  return out;
}

/**
 * Test an account: list its models (the cheapest authenticated call), and when
 * a model is named (or the provider cannot list), make one real call with it.
 */
async function testAccount(body: Record<string, unknown>): Promise<{ result: Record<string, unknown>; recordFor: number | null }> {
  const kind = kindOf(body.kind);
  // A draft naming a saved account but another provider / URL is a different
  // endpoint: it gets neither the stored key nor the account's test record.
  const stored = body.id ? await getAccount(Number(body.id)) : null;
  const draftTarget = { provider: String(body.provider ?? ""), base_url: String(body.base_url ?? "") };
  const ownEndpoint = Boolean(stored && adminSettings.draftTargetsAccount(draftTarget, stored));
  const draft: adminSettings.ProfileDraft = {
    id: ownEndpoint ? stored!.id : undefined,
    account_name: ownEndpoint ? stored!.name : typeof body.name === "string" ? body.name : "",
    kind,
    provider: String(body.provider ?? ""),
    base_url: String(body.base_url ?? ""),
    api_key: typeof body.api_key === "string" ? body.api_key : "",
    model: String(body.model ?? "").trim(),
    params: (body.params as Record<string, unknown>) ?? {},
  };
  const listing = await adminSettings.listProfileModels(draft);
  let call: Record<string, unknown> | null = null;
  if (draft.model) call = (await adminSettings.testProfile(draft)) as unknown as Record<string, unknown>;
  const ok = call ? Boolean(call.ok) : listing.ok;
  const message = call ? String(call.message ?? "") : listing.message;
  const result = {
    ok,
    message,
    ...(call?.code ? { code: call.code, params: call.params } : codeFields(message)),
    models: listing.models,
    models_ok: listing.ok,
    models_message: listing.message,
    ...codeFields(listing.message, "models_"),
    call: call && { ...call, ...(call.code ? {} : codeFields(String(call.message ?? ""))) },
  };
  return { result, recordFor: ownEndpoint ? stored!.id : null };
}

export async function handleLlmApi(
  method: string,
  path: string,
  body: Record<string, unknown>,
  user: string,
  reply: Reply,
  refresh: () => Promise<void>,
): Promise<boolean> {
  if (!path.startsWith("/admin/api/llm/")) return false;
  const parts = path.slice("/admin/api/llm/".length).split("/").filter(Boolean);
  const [res, idPart, action] = parts;
  const id = idPart && /^\d+$/.test(idPart) ? Number(idPart) : null;
  try {
    // ── accounts ──
    if (res === "accounts") {
      if (method === "GET" && !idPart) {
        const accounts = (await listAccounts()).map(accountPublic).map((a) => {
          // Results recorded before codes existed carry only the English message.
          const lt = a.last_test as Record<string, unknown> | null | undefined;
          return lt && !lt.code ? { ...a, last_test: { ...lt, ...codeFields(typeof lt.message === "string" ? lt.message : "") } } : a;
        });
        reply(200, { accounts, cooling: coolingDown() });
        return true;
      }
      if (method === "POST" && !idPart) {
        const created = await createAccount(body as unknown as AccountInput, user);
        // A test the wizard ran on the draft before the account existed: keep it,
        // so the new card shows its result instead of "not tested".
        const lt = body.last_test as Record<string, unknown> | undefined;
        if (lt && typeof lt === "object" && typeof lt.ok === "boolean") {
          const message = typeof lt.message === "string" ? lt.message.slice(0, 500) : "";
          await recordAccountTest(created.id, {
            ok: lt.ok,
            message,
            model_count: Number.isInteger(lt.model_count) ? Number(lt.model_count) : undefined,
            ...codeFields(message),
          });
          created.last_test = (await getAccount(created.id))?.last_test ?? created.last_test;
        }
        await refresh();
        reply(200, { ok: true, account: accountPublic(created) });
        return true;
      }
      if (method === "POST" && idPart === "test") {
        const { result, recordFor } = await testAccount(body);
        if (recordFor !== null) {
          await recordAccountTest(recordFor, {
            ok: result.ok,
            message: result.message,
            model_count: (result.models as string[]).length,
            ...(result.code ? { code: result.code, params: result.params } : codeFields(String(result.message ?? ""))),
          });
        }
        reply(200, result);
        return true;
      }
      if (id !== null && method === "POST" && action === "models") {
        const acc = await getAccount(id);
        if (!acc) throw new ProfileNotFoundError(`No such account: ${id}`);
        const listing = await adminSettings.listProfileModels({
          id,
          kind: kindOf(body.kind),
          provider: acc.provider,
          base_url: acc.base_url,
          model: "",
          params: acc.params,
        });
        reply(200, { ...listing, ...codeFields(listing.message) });
        return true;
      }
      if (id !== null && (method === "PATCH" || method === "PUT") && !action) {
        const updated = await updateAccount(id, body as Partial<AccountInput>, user);
        await refresh();
        reply(200, { ok: true, account: accountPublic(updated) });
        return true;
      }
      if (id !== null && ((method === "DELETE" && !action) || (method === "POST" && action === "delete"))) {
        await deleteAccount(id, user);
        await refresh();
        reply(200, { ok: true });
        return true;
      }
    }

    // ── one model on an account ──
    if (res === "models" && idPart === "test" && method === "POST") {
      const acc = await getAccount(Number(body.provider_id));
      if (!acc) throw new ProfileValidationError("Unknown provider account.");
      const r = await adminSettings.testProfile({
        id: acc.id,
        account_name: acc.name,
        kind: kindOf(body.kind),
        provider: acc.provider,
        base_url: acc.base_url,
        model: String(body.model ?? "").trim(),
        params: { ...acc.params, ...((body.params as Record<string, unknown>) ?? {}) },
      });
      reply(200, { ...r, ...(r.code ? {} : codeFields(r.message)) });
      return true;
    }

    // ── routes (profiles) ──
    if (res === "routes") {
      if (method === "GET" && !idPart) {
        const routes = await listRoutes();
        const { staleEmbeddingRoutes } = await import("./embeddingIdentity.js");
        const stale = await staleEmbeddingRoutes(routes).catch(() => new Set<number>());
        reply(200, {
          // `stale`: an embedding profile with an endpoint known not to match the system model (e.g. after a switch).
          routes: routes.map((r) => (r.kind === "embedding" ? { ...r, stale: stale.has(r.id) } : r)),
          roles: await getRoleRoutes(),
          stats: await statsJson(),
          cooling: coolingDown(),
        });
        return true;
      }
      if (method === "POST" && !idPart) {
        const saved = await saveRoute(body as unknown as RouteInput, null, user);
        await refresh();
        reply(200, { ok: true, route: saved });
        return true;
      }
      if (id !== null && method === "PUT" && !action) {
        const saved = await saveRoute(body as unknown as RouteInput, id, user);
        await refresh();
        reply(200, { ok: true, route: saved });
        return true;
      }
      if (id !== null && method === "GET" && action === "impact") {
        reply(200, await planRouteDelete(id));
        return true;
      }
      if (id !== null && ((method === "DELETE" && !action) || (method === "POST" && action === "delete"))) {
        const plan = await deleteRoute(id, user, { confirm: typeof body.confirm === "string" ? body.confirm : undefined });
        await refresh();
        reply(200, { ok: true, plan });
        return true;
      }
      if (id !== null && method === "POST" && action === "test") {
        const route = (await listRoutes()).find((r) => r.id === id);
        if (!route) throw new ProfileNotFoundError(`No such profile: ${id}`);
        // The order a real request would take right now (strategy draw + cool-downs).
        const order = await routeCandidates(route.kind, id);
        if (order.length === 0) {
          reply(200, {
            ok: false,
            answered_by: null,
            order: [],
            attempts: [],
            message: "This profile has no enabled member to try (every member or its account is disabled).",
            code: "profile_no_enabled_members",
            params: {},
          });
          return true;
        }
        const attempts: Record<string, unknown>[] = [];
        let answered: number | null = null;
        for (const leaf of order) {
          const t0 = Date.now();
          const r = await adminSettings.testProfile({
            id: leaf.account_id,
            account_name: leaf.name.slice(0, Math.max(0, leaf.name.lastIndexOf(" · "))),
            kind: route.kind,
            provider: leaf.provider,
            base_url: leaf.base_url,
            api_key: leaf.api_key,
            model: leaf.model,
            params: leaf.params,
          });
          attempts.push({ member_id: leaf.id, name: leaf.name, ok: r.ok, latency_ms: Date.now() - t0, message: r.message, ...(r.code ? { code: r.code, params: r.params } : codeFields(r.message)), details: r.details ?? null });
          if (r.ok) {
            answered = leaf.id;
            break;
          }
        }
        reply(200, { ok: answered !== null, answered_by: answered, order: order.map((l) => l.id), attempts });
        return true;
      }
    }

    // ── ChatGPT subscription sign-in (official SIWC flow) ──
    if (res === "oauth" && idPart === "chatgpt" && method === "POST") {
      const oauth = await import("./chatgptOAuth.js");
      if (action === "start") {
        if (body.acknowledged !== true) throw new ProfileValidationError("Confirm the ChatGPT subscription terms before signing in.");
        reply(
          200,
          await oauth.startChatgptLogin({
            name: String(body.name ?? ""),
            accountId: body.account_id ? Number(body.account_id) : null,
            allowRoleUse: body.allow_role_use === true,
            user,
          }),
        );
        return true;
      }
      if (action === "complete") {
        const done = await oauth.completeChatgptLogin({ callbackUrl: String(body.callback_url ?? ""), user });
        await refresh();
        reply(200, { ok: true, ...done });
        return true;
      }
    }

    // ── system embedding identity (fingerprint) and model switching ──
    if (res === "embedding") {
      const ident = await import("./embeddingIdentity.js");
      if (method === "GET" && !idPart) {
        const identity = await ident.getIdentity();
        reply(200, {
          identity: identity && {
            version: identity.version,
            state: identity.state,
            model: identity.model,
            provider: identity.provider,
            account_name: identity.account_name,
            dimensions: identity.dimensions,
            created_at: identity.created_at,
            created_by: identity.created_by,
          },
          counts: await ident.vectorCounts(),
          min_similarity: ident.MIN_SIMILARITY,
          probe_count: ident.PROBE_TEXTS.length,
        });
        return true;
      }
      if ((method === "GET" || method === "POST") && idPart === "health") {
        reply(200, await ident.embeddingRoleHealth({ fresh: method === "POST" && body.fresh === true }));
        return true;
      }
      if (method === "POST" && idPart === "establish") {
        const existing = await ident.getIdentity();
        const identity =
          existing ?? (await ident.establishIdentity({ user, candidates: [], roleLeaves: async () => (await import("./llmRouting.js")).roleLeaves("embedding") }));
        reply(200, { ok: identity !== null, created: !existing && identity !== null, identity: identity && { model: identity.model, dimensions: identity.dimensions, account_name: identity.account_name, version: identity.version } });
        return true;
      }
      if (method === "POST" && (idPart === "check" || idPart === "switch" || idPart === "precheck")) {
        const acc = await getAccount(Number(body.provider_id));
        if (!acc) throw new ProfileValidationError("Unknown provider account.");
        const model = String(body.model ?? "").trim();
        if (!model) throw new ProfileValidationError("Model is required.");
        const leaf = leafFromAccount(acc, model, (body.params as Record<string, unknown>) ?? {}, "embedding");
        if (idPart === "check") {
          // `cached: true` reuses a verdict from this identity version (list views); default re-embeds.
          try {
            const r = await ident.checkFingerprint(leaf, { fresh: body.cached !== true });
            reply(200, { ...r, ...codeFields(r.message) });
          } catch (exc) {
            const message = String((exc as Error).message);
            // Not a server error: a verdict about this endpoint. "Unreachable" is an
            // outage; anything else (model missing, HTTP 4xx/5xx, no vectors) means
            // it answered but cannot serve as this embedding model.
            const issue = exc instanceof ProfileValidationError && !(exc instanceof CodedProfileError)
              ? { code: "embedding_incompatible", params: { status: 0, detail: message } }
              : await diagnoseEmbedFailure(leaf, exc);
            const unreachable = issue.code === "embedding_endpoint_unreachable";
            reply(200, {
              ok: false,
              unreachable,
              incompatible: !unreachable,
              anchor_missing: false,
              min_similarity: null,
              mean_similarity: null,
              dimensions: null,
              message,
              code: issue.code,
              params: issue.params,
            });
          }
          return true;
        }
        if (idPart === "precheck") {
          reply(200, await ident.precheckSwitch(leaf));
          return true;
        }
        const has = await ident.systemHasEmbeddings();
        if (has && body.confirm !== "REINDEX") throw new ProfileValidationError("Type REINDEX to confirm: every existing vector will be deleted and rebuilt.");
        const result = await ident.switchEmbeddingModel({
          leaf,
          user,
          bindNewProfile: async (l) => {
            const base = `Embedding（${l.model}）`;
            const names = new Set((await listRoutes()).map((r) => r.name));
            let name = base;
            for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
            const route = await saveRoute(
              {
                name,
                kind: "embedding",
                strategy: "single",
                description: "由切換 Embedding 模型建立",
                // `dimensions` is written explicitly: it is what the vector columns now hold.
                members: [{ member_type: "model", provider_id: acc.id, model: l.model, weight: 1, enabled: true, params: { ...((body.params as Record<string, unknown>) ?? {}), dimensions: embeddingDimensions(l) } }],
              },
              null,
              user,
              { skipFingerprint: true },
            );
            await setRoleRoute("embedding", route.id, user, { skipFingerprint: true });
            return { id: route.id, name: route.name };
          },
        });
        await refresh();
        reply(200, { ok: true, ...result });
        return true;
      }
    }

    // ── role bindings ──
    if (res === "roles" && method === "PUT") {
      const routeId = body.route_id === null || body.route_id === undefined ? null : Number(body.route_id);
      if (routeId !== null && !Number.isInteger(routeId)) throw new ProfileValidationError(`No such profile: ${String(body.route_id)}`);
      await setRoleRoute(roleOf(body.role), routeId, user);
      await refresh();
      reply(200, { ok: true, roles: await getRoleRoutes() });
      return true;
    }

    reply(404, { error: `Unknown LLM route: ${method} ${path}` });
    return true;
  } catch (exc) {
    // Coded errors carry their own code + params (and status: 409 when the request
    // conflicts with the system's embedding model); the raw text goes to `detail`
    // for the console's "技術細節" disclosure only.
    if (exc instanceof CodedProfileError) reply(exc.status, { error: exc.message, detail: exc.message, code: exc.code, params: exc.params });
    else if (exc instanceof ProfileNotFoundError) reply(404, { error: exc.message, ...codeFields(exc.message) });
    else if (exc instanceof ProfileValidationError) reply(400, { error: exc.message, ...codeFields(exc.message) });
    else reply(500, { error: "LLM configuration operation failed", detail: String((exc as Error).message), ...errorFields(exc) });
    return true;
  }
}

-- Provider registry (2026-10). Data-only: no schema change, nothing to fold into
-- db/schema.sql. The backend also resolves these legacy values at runtime
-- (providers/registry.ts canonicalProviderId), so this only makes stored rows —
-- and the admin UI's provider picker — match the registry ids.

BEGIN;

-- `openai` now means the official API only; anything else speaking the OpenAI
-- wire format (vLLM, LM Studio, oMLX, LiteLLM…) is `openai_compatible`.
UPDATE admin.llm_profiles
   SET provider = 'openai_compatible', updated_at = NOW()
 WHERE provider = 'openai'
   AND base_url !~* '^https://api\.openai\.com(/|$)';

UPDATE admin.llm_profiles SET provider = 'openai_compatible', updated_at = NOW() WHERE provider = 'vllm';
UPDATE admin.llm_profiles SET provider = 'gemini', updated_at = NOW() WHERE provider = 'google';

-- SiliconFlow profiles used to store the full embeddings URL as the base; the
-- adapter needs the API root so the same profile can also list models.
UPDATE admin.llm_profiles
   SET base_url = regexp_replace(base_url, '/(embeddings|chat/completions)/?$', ''), updated_at = NOW()
 WHERE provider = 'siliconflow'
   AND base_url ~ '/(embeddings|chat/completions)/?$';

COMMIT;

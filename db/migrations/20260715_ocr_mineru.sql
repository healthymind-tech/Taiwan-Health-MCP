-- OCR backend: dots_ocr (in-process VLM) -> MinerU (external HTTP service).
--
-- The 'ocr' settings group was re-keyed: server_ip / port / model / prompt_mode
-- described a vLLM endpoint and an OCR prompt that no longer exist, and the
-- provider enum changed from dots_ocr|vllm to mineru. Stale rows would be ignored
-- by the schema-driven settings reader, but they would keep turning up in settings
-- exports and would make `is_group_configured('ocr')` answer true for a group that
-- holds no usable endpoint — so drop them and let the operator configure MinerU.
--
-- Deployments that never configured OCR (no 'ocr' rows at all) are unaffected.

DELETE FROM admin.app_settings
 WHERE group_key = 'ocr'
   AND key IN ('server_ip', 'port', 'model', 'prompt_mode');

DELETE FROM admin.app_settings
 WHERE group_key = 'ocr'
   AND key = 'provider'
   AND value IN ('dots_ocr', 'vllm');

# FAQ

The questions users most commonly hit while using Taiwan Health MCP.

## Browse by category

### [Usage](usage.md)
Missing data, keyword search techniques, and so on.

### [LOINC](loinc.md)
Questions about LOINC code mapping and reference values.

## Quick answers

### Q: Why are some tools missing?
**A**: Module-backed tools are enabled and disabled automatically according to data-load status. If the corresponding module has not been imported (or has not reached the row-count threshold), its tools are not registered. Check each module's status with `health_check` first, or import the module under Admin → Modules.

### Q: Why do search results look keyword-only rather than semantic?
**A**: Semantic / hybrid search needs a reachable embedding endpoint (Ollama by default). The endpoint is configured in the admin console under **Settings → LLM Profiles** (stored in `admin.llm_profiles`) — **not** through environment variables. When it is unset or unreachable, search falls back to keyword mode and the response carries a `keyword_only` signal. Note also that each module's vectors must be backfilled by its `*_embed` job first; otherwise you get keyword-only results even with a working endpoint.

### Q: Installation and deployment questions?
**A**: See [Getting Started](../getting-started.md) and the [Deployment Guide](../deployment/index.md).

### Q: FHIR format and validation questions?
**A**: For basic Condition / Medication conversion see [FHIR Tools](../tools/fhir-tools.md); for profile- and terminology-level authoring and validation see [FHIR IG Service](../modules/fhir-ig-service.md).

# FHIR Server Tools

This group is used to discover and operate **external FHIR R4 servers** registered through the admin console. These tools are always registered (independent of data module load status). Adding and editing servers, authentication credentials, and health-check settings all happen in Admin Console → FHIR Servers; the MCP side sees only a safe summary and **never** obtains or relays tokens, client secrets, or private keys.

## list_fhir_servers
List the available external FHIR servers — the discovery entry point.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `include_disabled` | boolean | No | Whether to include disabled (`enabled=false`) servers, `false` by default |

### Returns
`{count, servers: [...]}`. Each server carries `server_key` (use this value when calling the other tools), `name`, `base_url`, `enabled`, `default`, `allowed_resource_types`, `allowed_operations`, `fhir_version`, `supported_resources`, `auth` (informational only), and `probe` (the most recent connectivity check).

## get_fhir_server_status
Retrieve the status and configuration of a **single** server, with the same fields as `list_fhir_servers`.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `server_key` | string | Yes | The server's stable identifier (not its name) |

### Purpose
Before calling `crud_fhir_server`, confirm `enabled=true` and `probe.ok=true`. If not, run a `metadata` operation first or alert the user.

## crud_fhir_server
Perform a FHIR REST operation against a given server.

### Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `server_key` | string | Yes | Target server identifier (`"default"` selects the default server) |
| `operation` | string | Yes | `metadata` / `read` / `search` / `create` / `update` / `patch` / `delete` |
| `resource_type` | string | Depends on operation | FHIR resource type (such as `Patient` or `Observation`) |
| `resource_id` | string | Depends on operation | Target resource ID (read / update / patch / delete) |
| `query_json` | string | Used by `search` | Search parameters as a JSON object string, e.g. `'{"name":"Chen","_count":"10"}'` |
| `resource_json` | string | Required for `create` / `update` | The full FHIR resource as a JSON string |
| `patch_json` | string | Required for `patch` | A JSON Patch array as a string |
| `confirm_write` | boolean | Required for writes | Write operations (create / update / patch / delete) only execute when this is `true` |
| `token_strategy` | string | No | Override the server's default token strategy: `auto` (default) / `fresh` / `cached` |

### Notes
- Operations and resource types are constrained by the server's `allowed_operations` / `allowed_resource_types`; anything not permitted is rejected outright.
- The path is composed from `operation` / `resource_type` / `resource_id`; the caller does **not** pass a URL directly. Query strings and request bodies come from `query_json`, `resource_json`, and `patch_json` instead — all of them JSON **strings**, not objects.
- OAuth tokens are handled by the MCP server on the caller's behalf; the caller never touches them.
- Client Credentials (including `private_key_jwt`) obtain tokens per the `fresh` / `cached` strategy; Authorization Code uses the encrypted grant stored by the admin console and refreshes automatically on expiry. An Authorization Code server must complete **Authorize** in Admin → FHIR Servers first.

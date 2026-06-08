#!/usr/bin/env python3
"""
Interactive MCP Server Test Script
===================================
Connects to a running Taiwan Health MCP server, lists available tools,
and lets you test any tool interactively with guided parameter input.

Usage:
  python mcp_test.py                                        # localhost:8000, interactive
  python mcp_test.py --url http://192.168.1.10:8000         # remote server
  python mcp_test.py --tool search_food_nutrition           # jump straight to a tool
  python mcp_test.py --tool search_food_nutrition --params '{"food_name":"白米"}'

Requirements:
  pip install httpx
"""

from __future__ import annotations

import argparse
import json
import os
import readline
import sys
from typing import Any

import httpx

# ── ANSI colours (disabled if not a TTY) ─────────────────────────────────────

_COLOUR = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOUR else text


def bold(t: str)    -> str: return _c("1", t)
def cyan(t: str)    -> str: return _c("36", t)
def green(t: str)   -> str: return _c("32", t)
def yellow(t: str)  -> str: return _c("33", t)
def red(t: str)     -> str: return _c("31", t)
def dim(t: str)     -> str: return _c("2", t)
def magenta(t: str) -> str: return _c("35", t)


# ── Readline history ──────────────────────────────────────────────────────────

_HISTORY_FILE = os.path.expanduser("~/.mcp_test_history")


def _setup_readline() -> None:
    try:
        readline.read_history_file(_HISTORY_FILE)
    except FileNotFoundError:
        pass
    readline.set_history_length(500)
    import atexit
    atexit.register(readline.write_history_file, _HISTORY_FILE)


def _input(prompt: str, prefill: str = "") -> str:
    """Input with optional prefill (for repeating previous value)."""
    if prefill:
        readline.set_startup_hook(lambda: readline.insert_text(prefill))
        try:
            return input(prompt)
        finally:
            readline.set_startup_hook()
    return input(prompt)


# ── MCP Client ────────────────────────────────────────────────────────────────

class MCPClient:
    """Minimal MCP streamable-http client."""

    def __init__(self, base_url: str) -> None:
        self.mcp_url = base_url.rstrip("/")
        if not self.mcp_url.endswith("/mcp"):
            self.mcp_url += "/mcp"
        self._session_id: str | None = None
        self._req_id = 0

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    def _parse_response(self, resp: httpx.Response) -> dict:
        if sid := resp.headers.get("Mcp-Session-Id"):
            self._session_id = sid
        ct = resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            for line in resp.text.splitlines():
                if line.startswith("data: "):
                    data = line[6:].strip()
                    if data and data != "[DONE]":
                        try:
                            return json.loads(data)
                        except json.JSONDecodeError:
                            pass
            return {}
        if resp.status_code == 202:
            return {}
        return resp.json()

    def _post(self, payload: dict, timeout: float = 60.0) -> dict:
        resp = httpx.post(
            self.mcp_url,
            json=payload,
            headers=self._headers(),
            timeout=timeout,
            follow_redirects=True,
        )
        resp.raise_for_status()
        return self._parse_response(resp)

    def connect(self) -> bool:
        """Initialise MCP session. Returns True on success."""
        try:
            result = self._post({
                "jsonrpc": "2.0",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "mcp-test-script", "version": "1.0"},
                },
                "id": self._next_id(),
            })
            if "error" in result:
                print(red(f"  Initialize error: {result['error']}"))
                return False
            # Send initialized notification (fire-and-forget, 202 expected)
            try:
                self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=5)
            except Exception:
                pass
            return True
        except httpx.ConnectError:
            return False
        except Exception as exc:
            print(red(f"  Connection failed: {exc}"))
            return False

    def list_tools(self) -> list[dict]:
        result = self._post({
            "jsonrpc": "2.0",
            "method": "tools/list",
            "id": self._next_id(),
        })
        return result.get("result", {}).get("tools", [])

    def call_tool(self, name: str, arguments: dict) -> Any:
        result = self._post({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
            "id": self._next_id(),
        }, timeout=120.0)
        if "error" in result:
            return {"error": result["error"]}
        content = result.get("result", {}).get("content", [])
        if content and content[0].get("type") == "text":
            try:
                return json.loads(content[0]["text"])
            except json.JSONDecodeError:
                return content[0]["text"]
        return result.get("result")


# ── Parameter input helpers ───────────────────────────────────────────────────

def _type_label(prop: dict) -> str:
    t = prop.get("type", "string")
    if t == "array":
        items_t = prop.get("items", {}).get("type", "string")
        return f"array[{items_t}]"
    return t


def _coerce(raw: str, prop: dict) -> Any:
    """Convert raw string input to the correct Python type."""
    t = prop.get("type", "string")
    raw = raw.strip()

    if t == "integer":
        return int(raw)
    if t == "number":
        return float(raw)
    if t == "boolean":
        return raw.lower() in ("true", "yes", "1", "y")
    if t == "array":
        # Accept JSON array or comma-separated values
        raw = raw.strip()
        if raw.startswith("["):
            return json.loads(raw)
        items_t = prop.get("items", {}).get("type", "string")
        parts = [p.strip().strip('"\'') for p in raw.split(",") if p.strip()]
        if items_t == "integer":
            return [int(p) for p in parts]
        if items_t == "number":
            return [float(p) for p in parts]
        return parts
    if t == "object":
        return json.loads(raw)
    return raw  # string


def _prompt_param(
    name: str,
    prop: dict,
    required: bool,
    prev_value: Any = None,
) -> Any:
    """Interactively prompt for a single parameter."""
    type_str  = yellow(_type_label(prop))
    req_str   = bold(red("*")) if required else dim("optional")
    desc      = prop.get("description", "")
    # Trim long descriptions
    if len(desc) > 120:
        desc = desc[:117] + "..."

    print(f"    {bold(name)}  [{type_str}]  {req_str}")
    if desc:
        print(f"    {dim(desc)}")
    if "enum" in prop:
        print(f"    {dim('Choices: ' + ', '.join(str(e) for e in prop['enum']))}")

    prefill = ""
    if prev_value is not None:
        if isinstance(prev_value, (list, dict)):
            prefill = json.dumps(prev_value, ensure_ascii=False)
        else:
            prefill = str(prev_value)

    while True:
        prompt_text = f"    > "
        try:
            raw = _input(prompt_text, prefill=prefill).strip()
        except (EOFError, KeyboardInterrupt):
            raise KeyboardInterrupt

        if raw == "" and not required:
            return None          # skip optional
        if raw == "" and required:
            print(red("    This parameter is required."))
            continue

        try:
            return _coerce(raw, prop)
        except (ValueError, json.JSONDecodeError) as exc:
            print(red(f"    Invalid value ({exc}). Try again."))


def _prompt_all_params(
    schema: dict,
    prev_args: dict | None = None,
) -> dict:
    """Walk through all parameters, required first then optional."""
    properties = schema.get("properties", {})
    required   = set(schema.get("required", []))

    if not properties:
        print(dim("  (This tool takes no parameters)"))
        return {}

    result: dict[str, Any] = {}

    # ── Required parameters ───────────────────────────────────────────────────
    req_props = [(n, p) for n, p in properties.items() if n in required]
    if req_props:
        print(bold("\n  Required parameters:"))
        for name, prop in req_props:
            print()
            prev = (prev_args or {}).get(name)
            value = _prompt_param(name, prop, required=True, prev_value=prev)
            result[name] = value

    # ── Optional parameters ───────────────────────────────────────────────────
    opt_props = [(n, p) for n, p in properties.items() if n not in required]
    if opt_props:
        print(bold("\n  Optional parameters:") + dim("  (press Enter to skip)"))
        for name, prop in opt_props:
            print()
            prev = (prev_args or {}).get(name)
            value = _prompt_param(name, prop, required=False, prev_value=prev)
            if value is not None:
                result[name] = value

    return result


# ── Display helpers ───────────────────────────────────────────────────────────

def _print_banner(url: str, tool_count: int) -> None:
    print()
    print(bold(cyan("╔══════════════════════════════════════╗")))
    print(bold(cyan("║    Taiwan Health MCP Test Script     ║")))
    print(bold(cyan("╚══════════════════════════════════════╝")))
    print(f"  Server : {cyan(url)}")
    print(f"  Tools  : {green(str(tool_count))} available")
    print()


def _print_tools(tools: list[dict], filter_str: str = "") -> None:
    filtered = tools
    if filter_str:
        fl = filter_str.lower()
        filtered = [t for t in tools if fl in t["name"].lower()]

    if not filtered:
        print(yellow(f"  No tools match '{filter_str}'"))
        return

    cols = 2
    width = max(len(t["name"]) for t in filtered) + 2
    for i, tool in enumerate(filtered):
        num  = dim(f"{i+1:>3}.")
        name = cyan(tool["name"].ljust(width))
        line = f"  {num} {name}"
        if (i + 1) % cols == 0 or i == len(filtered) - 1:
            print(line)
        else:
            print(line, end="")
    print()


def _print_result(result: Any) -> None:
    print()
    print(bold("── Result " + "─" * 50))
    if isinstance(result, (dict, list)):
        print(green(json.dumps(result, ensure_ascii=False, indent=2)))
    else:
        print(green(str(result)))
    print(bold("─" * 60))


def _print_tool_header(tool: dict) -> None:
    print()
    print(bold(f"  Tool: {cyan(tool['name'])}"))
    desc = tool.get("description", "")
    # Print first paragraph only (up to first double newline or 200 chars)
    short = desc.split("\n\n")[0].replace("\n", " ").strip()
    if len(short) > 200:
        short = short[:197] + "..."
    if short:
        print(f"  {dim(short)}")


# ── Tool selection ────────────────────────────────────────────────────────────

def _select_tool(tools: list[dict]) -> dict | None:
    """Interactive tool selection: number, name, or search filter."""
    while True:
        try:
            raw = input(
                bold("Select tool") + " (number / name / part of name / " +
                cyan("?") + " to list / " + red("q") + " to quit): "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            return None

        if raw.lower() in ("q", "quit", "exit"):
            return None

        if raw == "?" or raw == "":
            _print_tools(tools)
            continue

        # Numeric selection
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(tools):
                return tools[idx]
            print(red(f"  Out of range (1–{len(tools)})"))
            continue

        # Exact name match
        exact = [t for t in tools if t["name"] == raw]
        if exact:
            return exact[0]

        # Partial / fuzzy match
        partial = [t for t in tools if raw.lower() in t["name"].lower()]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            print(yellow(f"  Multiple matches for '{raw}':"))
            _print_tools(partial)
            continue

        print(red(f"  No tool found for '{raw}'. Type ? to list all."))


# ── Main interactive loop ─────────────────────────────────────────────────────

def _run_interactive(client: MCPClient, tools: list[dict], start_tool: str | None = None) -> None:
    _print_tools(tools)

    while True:
        # ── Tool selection ────────────────────────────────────────────────────
        if start_tool:
            matches = [t for t in tools if t["name"] == start_tool or start_tool.lower() in t["name"].lower()]
            if not matches:
                print(red(f"\n  Tool '{start_tool}' not found on this server."))
                start_tool = None
                continue
            if len(matches) == 1:
                tool = matches[0]
            else:
                print(yellow(f"\n  Multiple matches for '{start_tool}':"))
                _print_tools(matches)
                tool = _select_tool(matches)
            start_tool = None   # only use on first iteration
        else:
            tool = _select_tool(tools)

        if tool is None:
            print(dim("\nBye!"))
            break

        _print_tool_header(tool)
        schema    = tool.get("inputSchema", {})
        prev_args: dict | None = None

        # ── Repeated test loop for the same tool ──────────────────────────────
        while True:
            try:
                args = _prompt_all_params(schema, prev_args=prev_args)
            except KeyboardInterrupt:
                print()
                break

            print()
            print(dim(f"  Calling {tool['name']}({json.dumps(args, ensure_ascii=False)}) …"))

            try:
                result = client.call_tool(tool["name"], args)
            except httpx.TimeoutException:
                print(red("\n  Request timed out."))
                result = None
            except Exception as exc:
                print(red(f"\n  Call failed: {exc}"))
                result = None

            if result is not None:
                _print_result(result)

            prev_args = args  # save for repeat

            # ── After result: what next? ──────────────────────────────────────
            try:
                again = input(
                    bold("\nWhat next? ") +
                    "[" + green("r") + "]epeat  " +
                    "[" + yellow("e") + "]dit  " +
                    "[" + cyan("n") + "]ew tool  " +
                    "[" + red("q") + "]uit: "
                ).strip().lower()
            except (EOFError, KeyboardInterrupt):
                print()
                return

            if again in ("q", "quit"):
                print(dim("\nBye!"))
                return
            if again in ("n", "new", ""):
                break       # back to tool selection
            if again in ("r", "repeat"):
                continue    # re-run with same params (prefilled)
            if again in ("e", "edit"):
                continue    # re-run but show prefilled params for editing
            # default: new tool
            break


# ── Non-interactive (CLI) mode ────────────────────────────────────────────────

def _run_once(client: MCPClient, tools: list[dict], tool_name: str, params_json: str | None) -> int:
    matches = [t for t in tools if t["name"] == tool_name]
    if not matches:
        print(red(f"Tool '{tool_name}' not found on this server."))
        available = [t["name"] for t in tools if tool_name.lower() in t["name"].lower()]
        if available:
            print(yellow("Did you mean: " + ", ".join(available)))
        return 1

    tool = matches[0]
    _print_tool_header(tool)

    if params_json:
        try:
            args = json.loads(params_json)
        except json.JSONDecodeError as exc:
            print(red(f"Invalid --params JSON: {exc}"))
            return 1
    else:
        # Guide through params interactively even in --tool mode
        try:
            args = _prompt_all_params(tool.get("inputSchema", {}))
        except KeyboardInterrupt:
            print()
            return 0

    print()
    print(dim(f"Calling {tool['name']}({json.dumps(args, ensure_ascii=False)}) …"))

    try:
        result = client.call_tool(tool["name"], args)
    except httpx.TimeoutException:
        print(red("Request timed out."))
        return 1
    except Exception as exc:
        print(red(f"Call failed: {exc}"))
        return 1

    _print_result(result)
    return 0


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Interactive test script for Taiwan Health MCP Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python mcp_test.py
  python mcp_test.py --url http://192.168.1.10:8000
  python mcp_test.py --tool search_food_nutrition
  python mcp_test.py --tool search_food_nutrition --params '{"food_name":"白米"}'
        """,
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("MCP_SERVER_URL", "http://localhost:8000"),
        help="MCP server base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--tool", "-t",
        default=None,
        help="Jump directly to this tool (name or partial match)",
    )
    parser.add_argument(
        "--params", "-p",
        default=None,
        help='Tool arguments as JSON string (requires --tool)',
    )
    args = parser.parse_args()

    _setup_readline()

    # ── Connect ───────────────────────────────────────────────────────────────
    url = args.url.rstrip("/")
    mcp_url = url + "/mcp" if not url.endswith("/mcp") else url
    print(f"\nConnecting to {cyan(mcp_url)} …", end=" ", flush=True)

    client = MCPClient(url)
    if not client.connect():
        print(red("FAILED"))
        print(red("\nCould not connect to the MCP server."))
        print(dim("Is the server running? Check: docker compose ps"))
        return 1
    print(green("OK"))

    # ── Fetch tools ───────────────────────────────────────────────────────────
    print("Fetching tool list …", end=" ", flush=True)
    try:
        tools = client.list_tools()
    except Exception as exc:
        print(red(f"FAILED: {exc}"))
        return 1

    if not tools:
        print(red("FAILED"))
        print(red("No tools returned — are the modules loaded?"))
        print(dim("Import modules from the admin console (Admin → Modules)."))
        return 1
    print(green(f"{len(tools)} tools"))

    _print_banner(mcp_url, len(tools))

    # ── Route to interactive or single-run mode ───────────────────────────────
    if args.tool:
        return _run_once(client, tools, args.tool, args.params)

    _run_interactive(client, tools, start_tool=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())

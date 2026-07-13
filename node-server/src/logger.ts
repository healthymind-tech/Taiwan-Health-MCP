/**
 * Structured JSON logging.
 *
 * Mirrors `src/utils.py`: one JSON object per record, written to **stderr**
 * (stdout is reserved for the MCP stdio transport). Field names and order match
 * the Python `_JsonFormatter`: `ts`, `level`, `logger`, `msg`, then any extras.
 */

const LOGGER_NAME = "taiwan_health_mcp";

type Extra = Record<string, unknown>;

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const;
type Level = (typeof LEVELS)[number];

let currentLevel: Level = "INFO";

/** Local-time `YYYY-MM-DDTHH:MM:SS`, matching Python's `formatTime(..., "%Y-%m-%dT%H:%M:%S")`. */
function formatTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function shouldEmit(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function emit(level: Level, message: string, extra: Extra): void {
  if (!shouldEmit(level)) return;
  const payload: Record<string, unknown> = {
    ts: formatTs(new Date()),
    level,
    logger: LOGGER_NAME,
    msg: message,
    ...extra,
  };
  process.stderr.write(JSON.stringify(payload) + "\n");
}

export function configureLogLevel(level: string): void {
  const upper = level.toUpperCase() as Level;
  currentLevel = LEVELS.includes(upper) ? upper : "INFO";
}

export function logDebug(message: string, extra: Extra = {}): void {
  emit("DEBUG", message, extra);
}

export function logInfo(message: string, extra: Extra = {}): void {
  emit("INFO", message, extra);
}

export function logWarning(message: string, extra: Extra = {}): void {
  emit("WARNING", message, extra);
}

export function logError(message: string, extra: Extra = {}): void {
  emit("ERROR", message, extra);
}

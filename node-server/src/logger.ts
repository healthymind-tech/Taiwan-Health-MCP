type LogFields = Record<string, unknown>;

function write(level: string, message: string, fields: LogFields = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields
  };
  const line = JSON.stringify(payload);
  // Always write logs to stderr. In MCP stdio mode stdout is reserved for
  // protocol frames; any regular log line on stdout corrupts the transport.
  console.error(line);
}

export const logger = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields)
};

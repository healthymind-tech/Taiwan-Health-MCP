import client from "prom-client";

client.collectDefaultMetrics({ prefix: "node_mcp_" });

export const toolRequests = new client.Counter({
  name: "node_mcp_tool_requests_total",
  help: "Total MCP tool invocations",
  labelNames: ["tool", "status"] as const
});

export const toolDuration = new client.Histogram({
  name: "node_mcp_tool_duration_seconds",
  help: "MCP tool execution latency",
  labelNames: ["tool"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

export const dependencyRequests = new client.Counter({
  name: "node_mcp_dependency_requests_total",
  help: "Dependency calls by dependency, operation, and status",
  labelNames: ["dependency", "operation", "status"] as const
});

export const dependencyDuration = new client.Histogram({
  name: "node_mcp_dependency_duration_seconds",
  help: "Dependency call latency by dependency and operation",
  labelNames: ["dependency", "operation"] as const,
  buckets: [
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
    10, 30
  ]
});

export function observeDependency<T>(
  dependency: string,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const end = dependencyDuration
    .labels(dependency, operation)
    .startTimer();
  return fn()
    .then((result) => {
      dependencyRequests.labels(dependency, operation, "success").inc();
      end();
      return result;
    })
    .catch((error) => {
      dependencyRequests.labels(dependency, operation, "error").inc();
      end();
      throw error;
    });
}

export async function metricsText(): Promise<string> {
  return client.register.metrics();
}

export function metricsContentType(): string {
  return client.register.contentType;
}

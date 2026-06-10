import { createClient } from "redis";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { observeDependency } from "./metrics.js";

export const redis = createClient({ url: config.redisUrl });

redis.on("error", (error) => {
  logger.warn("Redis client error", { error: String(error) });
});

export async function connectRedis(): Promise<void> {
  if (redis.isOpen) return;
  await observeDependency("redis", "connect", () => redis.connect());
}

export async function redisHealth(): Promise<boolean> {
  try {
    await connectRedis();
    await observeDependency("redis", "ping", () => redis.ping());
    return true;
  } catch {
    return false;
  }
}

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  try {
    await connectRedis();
    const hit = await observeDependency("redis", "get", () => redis.get(key));
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await loader();
    await observeDependency("redis", "setEx", () =>
      redis.setEx(key, ttlSeconds, JSON.stringify(value))
    );
    return value;
  } catch {
    return loader();
  }
}

export async function closeRedis(): Promise<void> {
  if (redis.isOpen) {
    await redis.quit();
  }
}

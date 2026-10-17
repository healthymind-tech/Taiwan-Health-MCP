import { Avatar, Tooltip } from "@mantine/core";
import { providerAccent } from "./llmApi";

/** Monogram avatar for a provider type, coloured consistently per type. */
export function ProviderAvatar({ provider, label, size = 34 }: { provider: string; label?: string; size?: number }) {
  const text = (label ?? provider).replace(/[^A-Za-z0-9一-鿿]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <Tooltip label={label ?? provider} disabled={!label} openDelay={400}>
      <Avatar size={size} radius="md" color={providerAccent(provider)} variant="light" style={{ flexShrink: 0 }}>
        {text}
      </Avatar>
    </Tooltip>
  );
}

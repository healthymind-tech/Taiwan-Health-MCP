import { Badge, Box, Grid, NavLink, ScrollArea, Skeleton, Stack, Text } from "@mantine/core";
import { IconFileCode } from "@tabler/icons-react";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/EmptyState";
import { SectionCard } from "@/components/SectionCard";
import { JsonCode } from "./parts";
import { useExampleResource } from "./profileApi";
import type { ExampleRef } from "./profileTypes";

/** Example titles from the store can be a Python-repr'd HumanName list; keep only readable ones. */
export function exampleTitle(e: ExampleRef): string | null {
  const t = (e.title ?? "").trim();
  if (!t || t === e.artifactId || t.startsWith("[{") || t.startsWith("{")) return null;
  return t;
}

/** Examples of the package whose meta.profile claims this profile, with a JSON viewer. */
export function ExamplesTab({ packageId, version, examples }: { packageId: string; version: string; examples: ExampleRef[] }) {
  const [sel, setSel] = useState<ExampleRef | null>(examples[0] ?? null);
  const q = useExampleResource(packageId, version, sel?.artifactId ?? null, sel?.resourceType ?? "");
  if (!examples.length) {
    return (
      <EmptyState
        icon={<IconFileCode size={28} />}
        title="沒有範例"
        description="這個 IG 套件內沒有 meta.profile 宣告此 Profile 的範例資源。"
      />
    );
  }
  return (
    <Grid gutter="md">
      <Grid.Col span={{ base: 12, md: 4 }}>
      <SectionCard title={`範例（${examples.length}）`} flush>
        <ScrollArea.Autosize mah={560} type="auto">
          <Box p={6}>
            {examples.map((e) => (
              <NavLink
                key={`${e.resourceType}/${e.artifactId}`}
                active={sel?.artifactId === e.artifactId && sel.resourceType === e.resourceType}
                onClick={() => setSel(e)}
                label={<Text ff="monospace" fz="sm">{e.artifactId}</Text>}
                description={exampleTitle(e) ?? e.resourceType}
                leftSection={<IconFileCode size={16} />}
                style={{ borderRadius: "var(--mantine-radius-md)" }}
              />
            ))}
          </Box>
        </ScrollArea.Autosize>
      </SectionCard>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 8 }}>
      <SectionCard
        title={sel ? sel.artifactId : "範例"}
        actions={sel ? <Badge variant="light">{sel.resourceType}</Badge> : undefined}
      >
        {q.isPending ? (
          <Stack gap={6}>
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} h={14} w={`${90 - (i % 4) * 15}%`} />
            ))}
          </Stack>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <JsonCode value={q.data.resource} maxHeight={640} />
        )}
      </SectionCard>
      </Grid.Col>
    </Grid>
  );
}

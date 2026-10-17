import { Button, Center, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconAlertTriangle, IconInbox, IconRefresh } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Center py={compact ? "lg" : 48} px="md">
      <Stack align="center" gap="xs" maw={440} ta="center">
        <ThemeIcon size={compact ? 40 : 56} radius="xl" variant="light" color="gray">
          {icon ?? <IconInbox size={compact ? 20 : 28} />}
        </ThemeIcon>
        <Title order={4} mt={4}>
          {title}
        </Title>
        {description && (
          <Text c="dimmed" fz="sm">
            {description}
          </Text>
        )}
        {action && <Stack mt="xs">{action}</Stack>}
      </Stack>
    </Center>
  );
}

export function ErrorState({ error, onRetry, title = "載入失敗" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <EmptyState
      icon={<IconAlertTriangle size={28} color="var(--mantine-color-red-6)" />}
      title={title}
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={onRetry}>
            重試
          </Button>
        )
      }
    />
  );
}

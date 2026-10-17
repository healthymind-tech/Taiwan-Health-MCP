import { Box, Card, Divider, Group, Text, ThemeIcon, Title } from "@mantine/core";
import type { CardProps } from "@mantine/core";
import type { ReactNode } from "react";

export interface SectionCardProps extends Omit<CardProps, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Remove body padding (for edge-to-edge tables). */
  flush?: boolean;
  children?: ReactNode;
}

/** A titled card section. Use `flush` for tables that should touch the card edges. */
export function SectionCard({ title, description, icon, actions, flush, children, ...rest }: SectionCardProps) {
  const hasHeader = Boolean(title || actions);
  return (
    <Card p={0} {...rest}>
      {hasHeader && (
        <>
          <Group justify="space-between" align="flex-start" gap="sm" px="lg" py="md" wrap="wrap">
            <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: "1 1 240px" }}>
              {icon && (
                <ThemeIcon variant="light" size={32} radius="md">
                  {icon}
                </ThemeIcon>
              )}
              <Box style={{ minWidth: 0 }}>
                {title && <Title order={3}>{title}</Title>}
                {description && (
                  <Text c="dimmed" fz="sm" mt={2}>
                    {description}
                  </Text>
                )}
              </Box>
            </Group>
            {actions && (
              <Group gap="xs" wrap="wrap">
                {actions}
              </Group>
            )}
          </Group>
          {children !== undefined && children !== null && <Divider />}
        </>
      )}
      {children !== undefined && children !== null && <Box p={flush ? 0 : "lg"}>{children}</Box>}
    </Card>
  );
}

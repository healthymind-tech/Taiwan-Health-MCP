import { Anchor, Box, Breadcrumbs, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { Link } from "react-router";

export interface Crumb {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned actions; wraps below the title on narrow screens. */
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Rendered inline after the title (status badge etc.). */
  badge?: ReactNode;
}

/** Standard page title block: breadcrumbs, icon, title, description, actions. */
export function PageHeader({ title, description, icon, actions, breadcrumbs, badge }: PageHeaderProps) {
  return (
    <Stack gap={6} mb="lg">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumbs separatorMargin={6} fz="xs">
          {breadcrumbs.map((c) =>
            c.to ? (
              <Anchor key={c.label} component={Link} to={c.to} c="dimmed" fz="xs">
                {c.label}
              </Anchor>
            ) : (
              <Text key={c.label} c="dimmed" fz="xs">
                {c.label}
              </Text>
            ),
          )}
        </Breadcrumbs>
      )}
      <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
        <Group gap="md" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: "1 1 320px" }}>
          {icon && (
            <ThemeIcon size={44} radius="md" variant="light">
              {icon}
            </ThemeIcon>
          )}
          <Box style={{ minWidth: 0 }}>
            <Group gap="sm" wrap="wrap">
              <Title order={1} style={{ wordBreak: "break-word" }}>
                {title}
              </Title>
              {badge}
            </Group>
            {description && (
              <Text c="dimmed" fz="sm" mt={4} maw={760}>
                {description}
              </Text>
            )}
          </Box>
        </Group>
        {actions && (
          <Group gap="xs" wrap="wrap" justify="flex-end">
            {actions}
          </Group>
        )}
      </Group>
    </Stack>
  );
}

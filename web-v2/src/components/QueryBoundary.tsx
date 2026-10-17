import { Skeleton, Stack } from "@mantine/core";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorState } from "./EmptyState";

/**
 * Render loading skeleton / error-with-retry / content for a query.
 *   <QueryBoundary query={q}>{(data) => <View data={data} />}</QueryBoundary>
 */
export function QueryBoundary<T>({
  query,
  children,
  skeleton,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <PageSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data as T)}</>;
}

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Stack gap="md">
      <Skeleton h={92} radius="lg" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} h={64} radius="lg" />
      ))}
    </Stack>
  );
}

import { Alert, Badge, Box, Button, Checkbox, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtCompact } from "@/lib/format";
import { useIsMobile } from "@/lib/hooks";
import { igRemovalKeys, refLabel, removalCode, removalErrorText, titledLabel, type IgRemovalResult, type IgUnusedDependency } from "./igRemoval";

/** Unused dependency installs (GET /admin/api/igs/unused-dependencies). */
export function useUnusedDependencies(enabled = true) {
  return useQuery({
    queryKey: igRemovalKeys.unused,
    queryFn: () => api.get<{ packages: IgUnusedDependency[] }>("/admin/api/igs/unused-dependencies"),
    enabled,
    staleTime: 15_000,
  });
}

/**
 * List dependency-installed packages no installed IG needs any more and
 * remove the selected ones as one set. The server re-checks each package
 * inside the removal transaction (IG_DEPENDENCY_IN_USE otherwise).
 */
export function UnusedDepsModal({
  opened,
  onClose,
  onRemoved,
  busyReason,
}: {
  opened: boolean;
  onClose: () => void;
  onRemoved: (r: IgRemovalResult) => void;
  /** Non-null while removal is not allowed (e.g. an IG import is running). */
  busyReason: string | null;
}) {
  const isMobile = useIsMobile();
  const q = useUnusedDependencies(opened);
  const list = q.data?.packages ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const listKey = list.map(refLabel).join("|");
  useEffect(() => {
    if (opened) setPicked(new Set(list.map(refLabel)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, listKey]);

  const remove = useMutation({
    mutationFn: () =>
      api.post<IgRemovalResult>("/admin/api/igs/unused-dependencies/remove", {
        packages: list.filter((p) => picked.has(refLabel(p))).map(({ package_id, version }) => ({ package_id, version })),
      }),
    onSuccess: (r) => onRemoved(r),
    onError: (e) => {
      if (removalCode(e)) void q.refetch();
    },
  });

  // Keep the selection closed: a package can only go if every unused package
  // that still declares it goes too (else the server refuses with IG_HAS_DEPENDENTS).
  const count = list.filter((p) => picked.has(refLabel(p))).length;
  const toggle = (k: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const byKey = new Map(list.map((p) => [refLabel(p), p]));
      if (next.has(k)) {
        // Unselect k and everything that k still needs.
        const stack = [k];
        while (stack.length) {
          const cur = stack.pop()!;
          if (!next.delete(cur)) continue;
          for (const p of list) if (p.needed_only_by.some((n) => refLabel(n) === cur)) stack.push(refLabel(p));
        }
      } else {
        // Select k and every unused package that declares it.
        const stack = [k];
        while (stack.length) {
          const cur = stack.pop()!;
          if (next.has(cur)) continue;
          next.add(cur);
          for (const n of byKey.get(cur)?.needed_only_by ?? []) stack.push(refLabel(n));
        }
      }
      return next;
    });

  return (
    <Modal opened={opened} onClose={() => !remove.isPending && onClose()} title="清理未使用的相依" size="lg" centered fullScreen={isMobile}>
      {q.isPending ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text fz="sm">檢查相依關係…</Text>
        </Group>
      ) : q.isError ? (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {removalErrorText(q.error)}
        </Alert>
      ) : list.length === 0 ? (
        <Stack gap="md">
          <Alert color="teal" variant="light" icon={<IconCircleCheck size={18} />}>
            沒有未使用的相依：每個「依賴安裝」的套件都仍被某個手動安裝的 IG 或預設 IG 需要。
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} data-autofocus>
              關閉
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text fz="sm">
            以下 {list.length} 個套件是為了滿足其他 IG 的相依而自動安裝的，但目前已沒有任何手動安裝的 IG 或預設 IG 需要它們。手動安裝的套件與安裝來源不明的套件不會列在這裡。
          </Text>
          <Stack gap={6}>
            {list.map((p) => {
              const k = refLabel(p);
              return (
                <Box key={k} p="xs" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
                  <Checkbox
                    checked={picked.has(k)}
                    onChange={() => toggle(k)}
                    disabled={remove.isPending}
                    label={
                      <Box style={{ minWidth: 0 }}>
                        <Text fz="sm" fw={600} style={{ wordBreak: "break-word" }}>
                          {titledLabel(p)}
                        </Text>
                        <Group gap={6} wrap="wrap" mt={2}>
                          <Badge size="xs" variant="light" color="gray">
                            {fmtCompact(p.counts.artifacts)} 構件
                          </Badge>
                          <Badge size="xs" variant="light" color="gray">
                            {fmtCompact(p.counts.concepts)} 概念
                          </Badge>
                        </Group>
                        <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                          {p.installed_for ? `原本由 ${refLabel(p.installed_for)} 帶入` : "帶入它的 IG 不明或已移除"}
                          {p.needed_only_by.length > 0 && `；只剩同樣未使用的 ${p.needed_only_by.map(refLabel).join("、")} 宣告相依`}
                        </Text>
                      </Box>
                    }
                  />
                </Box>
              );
            })}
          </Stack>
          {busyReason && (
            <Alert color="amber" icon={<IconAlertTriangle size={18} />}>
              {busyReason}
            </Alert>
          )}
          {remove.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="清理失敗">
              {removalErrorText(remove.error)}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" color="gray" onClick={onClose} disabled={remove.isPending} data-autofocus>
              取消
            </Button>
            <Button
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={() => remove.mutate()}
              loading={remove.isPending}
              disabled={count === 0 || Boolean(busyReason)}
            >
              移除 {count} 個套件
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

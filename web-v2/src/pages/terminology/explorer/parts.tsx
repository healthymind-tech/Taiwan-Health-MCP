import { Box, CloseButton, Loader, Paper, Popover, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useDebounced } from "@/lib/hooks";
import { tk } from "./termApi";
import classes from "./explorer.module.css";

/** Highlight occurrences of `q` (case-insensitive) in `text`. */
export function Hl({ text, q }: { text: string | null | undefined; q?: string }) {
  const s = text ?? "";
  const needle = (q ?? "").trim();
  if (!needle || needle.length < 2) return <>{s}</>;
  const i = s.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return <>{s}</>;
  return (
    <>
      {s.slice(0, i)}
      <mark className={classes.hl}>{s.slice(i, i + needle.length)}</mark>
      {s.slice(i + needle.length)}
    </>
  );
}

/**
 * Typeahead search: debounced, keyboard navigable (↑/↓/Enter/Esc), results in a
 * popover. `search` returns hits; `onPick` reveals the hit in the view.
 */
export function SearchBox<T>({
  id,
  placeholder,
  search,
  renderHit,
  hitKey,
  onPick,
  minLength = 1,
  autoFocus,
}: {
  id: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  renderHit: (hit: T, q: string) => ReactNode;
  hitKey: (hit: T) => string;
  onPick: (hit: T) => void;
  minLength?: number;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(value.trim(), 250);
  const res = useQuery({
    queryKey: tk("search", id, q),
    queryFn: () => search(q),
    enabled: q.length >= minLength,
    staleTime: 60_000,
  });
  const hits = q.length >= minLength ? (res.data ?? []) : [];
  useEffect(() => setActive(0), [q]);

  const pick = (h: T) => {
    onPick(h);
    setOpen(false);
  };

  return (
    <Popover opened={open && q.length >= minLength} onChange={setOpen} width="target" position="bottom-start" shadow="md" trapFocus={false} returnFocus={false}>
      <Popover.Target>
        <TextInput
          leftSection={res.isFetching ? <Loader size={14} /> : <IconSearch size={16} />}
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          aria-label={placeholder}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && hits[active]) {
              e.preventDefault();
              pick(hits[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
          rightSection={value ? <CloseButton size="sm" aria-label="清除搜尋" onClick={() => setValue("")} /> : null}
        />
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <Box className={classes.results} role="listbox">
          {res.isError ? (
            <Text fz="sm" c="red" p="sm">
              搜尋失敗
            </Text>
          ) : hits.length === 0 ? (
            <Text fz="sm" c="dimmed" p="sm">
              {res.isFetching ? "搜尋中…" : "沒有符合的結果"}
            </Text>
          ) : (
            hits.map((h, i) => (
              <UnstyledButton
                key={hitKey(h)}
                className={classes.result}
                data-active={i === active || undefined}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
              >
                {renderHit(h, q)}
              </UnstyledButton>
            ))
          )}
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}

export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Paper className={`${classes.panel} ${className ?? ""}`} p={0} radius="md">
      {(title || right) && (
        <Box className={classes.panelHead} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text fw={650} fz="sm">
            {title}
          </Text>
          {right}
        </Box>
      )}
      {children}
    </Paper>
  );
}

/** Kind colour shared by tree rows and badges. */
export const KIND_COLOR: Record<string, string> = {
  chapter: "var(--mantine-color-indigo-6)",
  block: "var(--mantine-color-violet-5)",
  category: "var(--mantine-color-brand-6)",
  header: "var(--mantine-color-gray-5)",
  billable: "var(--mantine-color-teal-6)",
};

export const KIND_LABEL: Record<string, string> = {
  chapter: "章",
  block: "節",
  category: "類目",
  header: "標頭",
  billable: "可申報",
};

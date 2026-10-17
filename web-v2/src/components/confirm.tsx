import { Alert, Button, Group, List, Stack, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  /** Bullet list of consequences shown in a warning box. */
  consequences?: ReactNode[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red button + warning styling. */
  danger?: boolean;
  /** Require typing this exact string before the confirm button enables. */
  typeToConfirm?: string;
  /** Keep the confirm button disabled (the action is known to be refused). */
  confirmDisabled?: boolean;
  /** Called on confirm; a rejected promise keeps the dialog open (error shown by caller). */
  onConfirm: () => unknown | Promise<unknown>;
  /** Called when the dialog closes without confirming (cancel button, Esc, overlay). */
  onCancel?: () => void;
}

const confirmed = new Set<string>();
/** Confirm dialogs currently open, and when the last one closed. */
const open = new Set<string>();
let lastClosedAt = 0;

/**
 * Is a confirm dialog open (or did one just close)? Esc is delivered to every
 * open Mantine overlay at once, so a drawer whose close handler asks "discard
 * changes?" must ignore the Esc that dismissed that very question.
 */
export function confirmIsOpen(): boolean {
  return open.size > 0 || Date.now() - lastClosedAt < 300;
}

function ConfirmBody({ opts, id }: { opts: ConfirmOptions; id: string }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = Boolean(opts.confirmDisabled) || (Boolean(opts.typeToConfirm) && typed.trim() !== opts.typeToConfirm);

  const run = async () => {
    setBusy(true);
    try {
      await opts.onConfirm();
      confirmed.add(id);
      modals.close(id);
    } catch {
      /* caller reports the error; keep dialog open so the user can retry/cancel */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      {opts.message && (
        <Text fz="sm" c="dimmed" component="div">
          {opts.message}
        </Text>
      )}
      {opts.consequences && opts.consequences.length > 0 && (
        <Alert color={opts.danger ? "red" : "amber"} icon={<IconAlertTriangle size={18} />} p="sm">
          <List size="sm" spacing={4}>
            {opts.consequences.map((c, i) => (
              <List.Item key={i}>{c}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {opts.typeToConfirm && (
        <TextInput
          label={
            <Text fz="sm" span>
              請輸入 <Text span ff="monospace" fw={700}>{opts.typeToConfirm}</Text> 以確認
            </Text>
          }
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          autoFocus
          autoComplete="off"
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && !locked && !busy) void run();
          }}
        />
      )}
      <Group justify="flex-end" gap="sm" mt="xs">
        <Button variant="default" onClick={() => modals.close(id)} disabled={busy}>
          {opts.cancelLabel ?? "取消"}
        </Button>
        <Button color={opts.danger ? "red" : undefined} onClick={() => void run()} loading={busy} disabled={locked}>
          {opts.confirmLabel ?? "確認"}
        </Button>
      </Group>
    </Stack>
  );
}

/** Open a confirmation dialog (optionally type-to-confirm). */
export function confirmAction(opts: ConfirmOptions): void {
  const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  open.add(id);
  modals.open({
    modalId: id,
    title: (
      <Text fw={650} fz="lg">
        {opts.title}
      </Text>
    ),
    size: "md",
    closeButtonProps: { "aria-label": "關閉" },
    onClose: () => {
      open.delete(id);
      lastClosedAt = Date.now();
      if (!confirmed.delete(id)) opts.onCancel?.();
    },
    children: <ConfirmBody opts={opts} id={id} />,
  });
}

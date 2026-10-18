import { Alert, Box, Button, Group, PasswordInput, Progress, Stack, Text } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { IconAlertTriangle, IconCheck, IconKey, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { notify } from "@/components/notify";
import { SectionCard } from "@/components/SectionCard";
import { api, ApiError, errorMessage } from "@/lib/api";

const MIN_LENGTH = 12;
const MAX_LENGTH = 512;

interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: string;
}

/** Heuristic strength: length dominates, character variety and repetition adjust. */
function strengthOf(pw: string): Strength {
  if (!pw) return { score: 0, label: "", color: "gray" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  let s = 0;
  if (pw.length >= 8) s += 1;
  if (pw.length >= MIN_LENGTH) s += 1;
  if (pw.length >= 16) s += 1;
  if (classes >= 3) s += 1;
  if (unique < pw.length / 3 || /^(.)\1+$/.test(pw)) s -= 2;
  if (/^(password|admin|123456|qwerty)/i.test(pw)) s = 0;
  const score = Math.max(0, Math.min(4, s)) as Strength["score"];
  const table: Record<Strength["score"], Omit<Strength, "score">> = {
    0: { label: "非常弱", color: "red" },
    1: { label: "弱", color: "red" },
    2: { label: "普通", color: "amber" },
    3: { label: "強", color: "teal" },
    4: { label: "非常強", color: "teal" },
  };
  return { score, ...table[score] };
}

function Requirement({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      {ok ? <IconCheck size={14} color="var(--mantine-color-teal-6)" /> : <IconX size={14} color="var(--mantine-color-dimmed)" />}
      <Text fz="xs" c={ok ? "teal" : "dimmed"}>
        {label}
      </Text>
    </Group>
  );
}

export function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const strength = strengthOf(next);
  const longEnough = next.length >= MIN_LENGTH;
  const notTooLong = next.length <= MAX_LENGTH;
  const differs = next !== "" && next !== current;
  const matches = next !== "" && next === confirm;
  const valid = current !== "" && longEnough && notTooLong && differs && matches;

  const change = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/admin/api/privacy/password", { current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setSubmitted(false);
      setFormError(null);
      notify.success("下次登入請使用新密碼。", "密碼已變更");
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.rawMessage : errorMessage(err);
      if (/current password is incorrect/i.test(msg)) setCurrentError("目前密碼不正確");
      else setFormError(err instanceof ApiError && err.explained ? errorMessage(err) : translate(msg));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setCurrentError(null);
    setFormError(null);
    if (valid) change.mutate();
  };

  return (
    <SectionCard title="變更密碼" description="管理員帳號用於登入此主控台的密碼。" icon={<IconKey size={18} />}>
      <form onSubmit={submit} noValidate>
        <Stack gap="md" maw={520}>
          {/* Hidden username helps password managers associate the new credential. */}
          <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
          <PasswordInput
            label="目前密碼"
            value={current}
            onChange={(e) => {
              setCurrent(e.currentTarget.value);
              setCurrentError(null);
            }}
            autoComplete="current-password"
            error={currentError ?? (submitted && !current ? "請輸入目前密碼" : undefined)}
            withAsterisk
          />
          <Box>
            <PasswordInput
              label="新密碼"
              value={next}
              onChange={(e) => setNext(e.currentTarget.value)}
              autoComplete="new-password"
              withAsterisk
              error={submitted && !(longEnough && notTooLong && differs) ? "新密碼不符合下列要求" : undefined}
            />
            {next && (
              <Group gap="sm" mt={8} wrap="nowrap">
                <Progress.Root size={6} radius="xl" style={{ flex: 1 }}>
                  {[0, 1, 2, 3].map((i) => (
                    <Progress.Section key={i} value={25} color={i < strength.score ? strength.color : "gray.3"} />
                  ))}
                </Progress.Root>
                <Text fz="xs" c={strength.color} fw={600} w={48} ta="right">
                  {strength.label}
                </Text>
              </Group>
            )}
            <Stack gap={2} mt={8}>
              <Requirement ok={longEnough} label={`至少 ${MIN_LENGTH} 個字元（建議使用多個單字組成的長密語）`} />
              <Requirement ok={differs} label="與目前密碼不同" />
              {!notTooLong && <Requirement ok={false} label={`不超過 ${MAX_LENGTH} 個字元`} />}
            </Stack>
          </Box>
          <PasswordInput
            label="再次輸入新密碼"
            value={confirm}
            onChange={(e) => setConfirm(e.currentTarget.value)}
            autoComplete="new-password"
            withAsterisk
            error={(submitted || confirm.length >= next.length) && confirm !== "" && !matches ? "兩次輸入的新密碼不一致" : submitted && !confirm ? "請再次輸入新密碼" : undefined}
          />
          {formError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} p="sm">
              {formError}
            </Alert>
          )}
          <Text fz="xs" c="dimmed">
            變更後，目前這個瀏覽器保持登入；其他已登入的工作階段不會被強制登出，會在工作階段到期後失效。
          </Text>
          <Group>
            <Button type="submit" loading={change.isPending} leftSection={<IconKey size={16} />}>
              變更密碼
            </Button>
          </Group>
        </Stack>
      </form>
    </SectionCard>
  );
}

function translate(msg: string): string {
  if (/New password is required/i.test(msg)) return "請輸入新密碼。";
  if (/too long/i.test(msg)) return `新密碼太長（上限 ${MAX_LENGTH} 字元）。`;
  return msg;
}

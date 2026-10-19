import {
  Alert,
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { IconAlertCircle, IconFingerprint, IconLock, IconShieldLock, IconStethoscope, IconUser, IconBolt } from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, errorMessage } from "@/lib/api";
import { safeNext } from "@/lib/loginRedirect";
import { ThemeMenu } from "@/components/ThemeMenu";
import { usePrefetchedWebAuthnOptions } from "@/lib/webauthnOptions";
import classes from "./LoginPage.module.css";

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);
  const [pkSupported, setPkSupported] = useState(false);

  useEffect(() => setPkSupported(browserSupportsWebAuthn()), []);
  const loginOptions = usePrefetchedWebAuthnOptions(
    "login",
    () => api.post<PublicKeyCredentialRequestOptionsJSON>("/admin/api/passkeys/login/options", {}, { skipAuthRedirect: true }),
    { enabled: pkSupported, paused: pkBusy },
  );

  /**
   * Leave only once the session is really usable. The server can accept the
   * login while the browser refuses to store the cookie (e.g. a `Secure` cookie
   * of the same name left by another deployment on this host, which an http page
   * may not overwrite) — navigating then would just bounce back here.
   */
  const go = async () => {
    try {
      await api.get("/admin/api/me", { skipAuthRedirect: true });
    } catch {
      setError(
        "帳號密碼正確，但瀏覽器沒有保存登入狀態。常見原因是同一台主機上的其他環境（例如 :8080）留下了同名的安全 cookie，http 頁面無法覆蓋它。請清除此網站（" +
          window.location.hostname +
          "）的 cookie 後再登入。",
      );
      return;
    }
    window.location.href = `/admin${next}`;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("請輸入帳號與密碼");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/admin/api/login", { username, password }, { skipAuthRedirect: true });
      await go();
    } catch (err) {
      setError(err instanceof ApiError && /Invalid username or password/.test(err.rawMessage) ? "帳號或密碼錯誤" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Runs inside the click: startAuthentication must not wait on the network (Safari). */
  const passkey = async () => {
    const options = loginOptions.data;
    if (!options) {
      setError(loginOptions.isError ? `無法取得通行金鑰參數：${errorMessage(loginOptions.error)}` : "通行金鑰還在準備中，請稍候一秒再試。");
      void loginOptions.refetch();
      return;
    }
    const ceremony = startAuthentication({ optionsJSON: options });
    setPkBusy(true);
    setError(null);
    try {
      const assertion = await ceremony;
      await api.post("/admin/api/passkeys/login/verify", assertion, { skipAuthRedirect: true });
      await go();
    } catch (err) {
      const msg = errorMessage(err);
      setError(/NotAllowed|abort|cancel/i.test(msg) ? "已取消通行金鑰登入" : `通行金鑰登入失敗：${msg}`);
    } finally {
      setPkBusy(false);
      // The challenge is single-use: fetch a fresh one for the next attempt.
      void loginOptions.refetch();
    }
  };

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing={0} className={classes.root}>
      <Box className={classes.hero} visibleFrom="md">
        <Stack gap="xl" maw={460}>
          <Group gap="sm">
            <Box className={classes.logo}>
              <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden>
                <path d="M27 14h10v13h13v10H37v13H27V37H14V27h13z" fill="currentColor" />
              </svg>
            </Box>
            <Text fw={700} fz="lg" c="white">
              Taiwan Health MCP
            </Text>
          </Group>
          <Title order={1} c="white" fz={34} lh={1.25}>
            台灣醫療資料
            <br />
            整合管理控制台
          </Title>
          <Text c="rgba(255,255,255,0.78)" fz="md">
            管理 ICD-10、LOINC、SNOMED CT、FHIR IG 與食藥署資料的匯入、向量嵌入、模型端點與外部 FHIR 伺服器。
          </Text>
          <Stack gap="md" mt="md">
            {[
              { icon: IconStethoscope, t: "醫療術語與 FHIR IG 一站式管理" },
              { icon: IconBolt, t: "背景工作即時進度與日誌" },
              { icon: IconShieldLock, t: "Session 驗證、通行金鑰、操作稽核" },
            ].map((f) => (
              <Group key={f.t} gap="sm" wrap="nowrap">
                <ThemeIcon size={34} radius="md" variant="white" color="brand" className={classes.featIcon}>
                  <f.icon size={18} />
                </ThemeIcon>
                <Text c="white" fz="sm" fw={500}>
                  {f.t}
                </Text>
              </Group>
            ))}
          </Stack>
        </Stack>
      </Box>

      <Box className={classes.formSide}>
        <Box className={classes.themeCorner}>
          <ThemeMenu />
        </Box>
        <Paper className={classes.card} p={{ base: "lg", sm: 40 }} radius="lg" shadow="md" withBorder>
          <Stack gap={4} mb="xl">
            <Group gap="xs" hiddenFrom="md" mb="md">
              <Box className={classes.logo} style={{ width: 36, height: 36 }}>
                <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden>
                  <path d="M27 14h10v13h13v10H37v13H27V37H14V27h13z" fill="currentColor" />
                </svg>
              </Box>
              <Text fw={700}>Taiwan Health MCP</Text>
            </Group>
            <Title order={2}>登入管理控制台</Title>
            <Text c="dimmed" fz="sm">
              請使用管理者帳號登入
            </Text>
          </Stack>

          <form onSubmit={submit} noValidate>
            <Stack gap="md">
              {error && (
                <Alert color="red" icon={<IconAlertCircle size={18} />} p="sm">
                  {error}
                </Alert>
              )}
              <TextInput
                label="帳號"
                placeholder="admin"
                leftSection={<IconUser size={16} />}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                autoComplete="username"
                autoFocus
                size="md"
                name="username"
              />
              <PasswordInput
                label="密碼"
                placeholder="輸入密碼"
                leftSection={<IconLock size={16} />}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                autoComplete="current-password"
                size="md"
                name="password"
              />
              <Button type="submit" size="md" loading={busy} fullWidth mt="xs">
                登入
              </Button>
            </Stack>
          </form>

          {pkSupported && (
            <>
              <Divider label="或" labelPosition="center" my="lg" />
              <Button
                variant="default"
                size="md"
                fullWidth
                leftSection={<IconFingerprint size={18} />}
                onClick={() => void passkey()}
                loading={pkBusy}
              >
                使用通行金鑰登入
              </Button>
            </>
          )}
          <Text fz="xs" c="dimmed" ta="center" mt="xl">
            忘記密碼？請聯繫系統管理員，或參考{" "}
            <Anchor href="https://healthymind-tech.github.io/Taiwan-Health-MCP/admin/" target="_blank" fz="xs">
              管理後台文件
            </Anchor>
          </Text>
        </Paper>
      </Box>
    </SimpleGrid>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Menu,
  Tooltip,
  VisuallyHidden,
  useComputedColorScheme,
  useMantineColorScheme,
  type MantineColorScheme,
} from "@mantine/core";
import { IconCheck, IconDeviceDesktop, IconMoon, IconSun, type Icon } from "@tabler/icons-react";
import { crossFadeColors, switchColorScheme } from "@/lib/themeTransition";
import classes from "./ThemeMenu.module.css";

const OPTIONS: { value: MantineColorScheme; label: string; icon: Icon }[] = [
  { value: "light", label: "淺色", icon: IconSun },
  { value: "dark", label: "深色", icon: IconMoon },
  { value: "auto", label: "跟隨系統", icon: IconDeviceDesktop },
];

export const COLOR_SCHEME_LABEL: Record<MantineColorScheme, string> = {
  light: "淺色",
  dark: "深色",
  auto: "跟隨系統",
};

/** Gentle colour fade when the OS theme flips while the user follows the system. */
function useSystemSchemeFade(colorScheme: MantineColorScheme): void {
  useEffect(() => {
    if (colorScheme !== "auto" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    // Mantine's own listener flips the attribute in the same task; adding the
    // fade class before the next style recalc is enough to animate it.
    const onChange = () => crossFadeColors();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [colorScheme]);
}

/** Light / Dark / System picker. "auto" (follow the OS) is the default. */
export function ThemeMenu() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [open, setOpen] = useState(false);
  const computed = useComputedColorScheme("light");
  const triggerRef = useRef<HTMLButtonElement>(null);
  useSystemSchemeFade(colorScheme);

  // The trigger shows the chosen mode; "auto" shows the monitor icon.
  const kind = colorScheme === "auto" ? "auto" : computed === "dark" ? "moon" : "sun";
  const current = colorScheme === "auto" ? `跟隨系統（目前為${computed === "dark" ? "深色" : "淺色"}）` : COLOR_SCHEME_LABEL[colorScheme];

  const choose = (value: MantineColorScheme) => {
    switchColorScheme(setColorScheme, value, triggerRef.current);
  };

  return (
    <>
      <Menu width={190} position="bottom-end" opened={open} onChange={setOpen}>
        <Menu.Target>
          <Tooltip label={`外觀：${current}`} disabled={open}>
            <ActionIcon ref={triggerRef} size="lg" aria-label={`外觀：${current}`} data-theme-toggle="">
              <span className={classes.icon} aria-hidden>
                <IconSun size={18} data-kind="sun" data-active={kind === "sun"} />
                <IconMoon size={18} data-kind="moon" data-active={kind === "moon"} />
                <IconDeviceDesktop size={18} data-kind="auto" data-active={kind === "auto"} />
              </span>
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>外觀</Menu.Label>
          {OPTIONS.map((o) => {
            const selected = colorScheme === o.value;
            return (
              <Menu.Item
                key={o.value}
                leftSection={<o.icon size={16} />}
                rightSection={selected ? <IconCheck size={15} color="var(--mantine-primary-color-filled)" /> : null}
                onClick={() => choose(o.value)}
                fw={selected ? 650 : undefined}
                aria-current={selected ? "true" : undefined}
              >
                {o.label}
              </Menu.Item>
            );
          })}
        </Menu.Dropdown>
      </Menu>
      <VisuallyHidden role="status" aria-live="polite">
        {`外觀已設為${current}`}
      </VisuallyHidden>
    </>
  );
}

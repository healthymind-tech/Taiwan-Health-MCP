import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Menu,
  Modal,
  NavLink,
  Notification,
  Paper,
  Popover,
  SegmentedControl,
  Select,
  Switch,
  Table,
  Tabs,
  TextInput,
  Tooltip,
  createTheme,
  rem,
  type MantineColorsTuple,
} from "@mantine/core";

/**
 * Design tokens for the admin console.
 *
 * Palette intent: a calm clinical teal as the single brand/action colour, slate
 * neutrals, and status colours reserved strictly for status (never decoration).
 * The dark palette is a cool blue-black, not pure grey, so surfaces keep depth.
 */

// Brand — deep clinical teal. Shade 7 is the light-mode primary (AA on white).
const brand: MantineColorsTuple = [
  "#e7f8f8",
  "#d4eeef",
  "#a8dbdd",
  "#78c7cb",
  "#52b6bb",
  "#3aacb1",
  "#2ba6ac",
  "#0b7a83",
  "#056d74",
  "#005e65",
];

// Slate neutrals for the light theme.
const gray: MantineColorsTuple = [
  "#f8fafc",
  "#f1f5f9",
  "#e2e8f0",
  "#cbd5e1",
  "#94a3b8",
  "#64748b",
  "#475569",
  "#334155",
  "#1e293b",
  "#0f172a",
];

// Dark surfaces: [0]=text … [4]=borders, [6]=inputs/cards, [7]=body.
const dark: MantineColorsTuple = [
  "#d5dde6",
  "#b4bfcc",
  "#8f9cad",
  "#66748a",
  "#3b4656",
  "#2a3341",
  "#1d2530",
  "#141a22",
  "#0f141a",
  "#0a0e13",
];

const indigo: MantineColorsTuple = [
  "#eef2ff",
  "#e0e7ff",
  "#c7d2fe",
  "#a5b4fc",
  "#818cf8",
  "#6366f1",
  "#4f46e5",
  "#4338ca",
  "#3730a3",
  "#312e81",
];

const amber: MantineColorsTuple = [
  "#fffbeb",
  "#fef3c7",
  "#fde68a",
  "#fcd34d",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#b45309",
  "#92400e",
  "#78350f",
];

export const theme = createTheme({
  primaryColor: "brand",
  primaryShade: { light: 7, dark: 5 },
  colors: { brand, gray, dark, indigo, amber },
  white: "#ffffff",
  black: "#0f172a",
  defaultRadius: "md",
  cursorType: "pointer",
  autoContrast: true,
  luminanceThreshold: 0.36,
  fontFamily:
    '"Inter Variable", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, -apple-system, "Segoe UI", sans-serif',
  fontFamilyMonospace: '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  headings: {
    fontFamily:
      '"Inter Variable", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
    fontWeight: "650",
    sizes: {
      h1: { fontSize: rem(26), lineHeight: "1.25" },
      h2: { fontSize: rem(21), lineHeight: "1.3" },
      h3: { fontSize: rem(17), lineHeight: "1.35" },
      h4: { fontSize: rem(15), lineHeight: "1.4" },
    },
  },
  fontSizes: { xs: rem(12), sm: rem(13.5), md: rem(14.5), lg: rem(16), xl: rem(18) },
  radius: { xs: rem(4), sm: rem(6), md: rem(8), lg: rem(12), xl: rem(16) },
  shadows: {
    xs: "0 1px 2px rgba(15, 23, 42, 0.05)",
    sm: "0 1px 3px rgba(15, 23, 42, 0.07), 0 1px 2px rgba(15, 23, 42, 0.04)",
    md: "0 6px 16px -4px rgba(15, 23, 42, 0.10), 0 2px 4px rgba(15, 23, 42, 0.05)",
    lg: "0 16px 40px -8px rgba(15, 23, 42, 0.18)",
    xl: "0 24px 60px -12px rgba(15, 23, 42, 0.28)",
  },
  breakpoints: { xs: "36em", sm: "48em", md: "62em", lg: "75em", xl: "88em" },
  components: {
    Button: Button.extend({ defaultProps: { radius: "md", fw: 560 } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { radius: "md", variant: "subtle", color: "gray" } }),
    Card: Card.extend({ defaultProps: { radius: "lg", withBorder: true, padding: "lg", shadow: "xs" } }),
    Paper: Paper.extend({ defaultProps: { radius: "lg" } }),
    Badge: Badge.extend({ defaultProps: { radius: "sm", variant: "light", fw: 600 } }),
    Modal: Modal.extend({
      defaultProps: {
        radius: "lg",
        centered: true,
        overlayProps: { backgroundOpacity: 0.45, blur: 3 },
        transitionProps: { transition: "pop", duration: 160 },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: { overlayProps: { backgroundOpacity: 0.4, blur: 2 }, position: "right" },
    }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 250, multiline: true, maw: 320 } }),
    Popover: Popover.extend({ defaultProps: { shadow: "md", radius: "md", withArrow: true } }),
    Menu: Menu.extend({ defaultProps: { shadow: "md", radius: "md", withArrow: false, position: "bottom-end" } }),
    TextInput: TextInput.extend({ defaultProps: { radius: "md" } }),
    Select: Select.extend({
      defaultProps: { radius: "md", allowDeselect: false, checkIconPosition: "right", comboboxProps: { shadow: "md" } },
    }),
    Checkbox: Checkbox.extend({ defaultProps: { radius: "sm" } }),
    Switch: Switch.extend({ defaultProps: { withThumbIndicator: false } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: "md" } }),
    Tabs: Tabs.extend({ defaultProps: { keepMounted: false } }),
    Table: Table.extend({
      defaultProps: { verticalSpacing: "sm", horizontalSpacing: "md", highlightOnHover: true },
    }),
    NavLink: NavLink.extend({ defaultProps: { variant: "light" } }),
    Alert: Alert.extend({ defaultProps: { radius: "md", variant: "light" } }),
    Notification: Notification.extend({ defaultProps: { radius: "md" } }),
  },
  other: {
    sidebarWidth: 256,
    headerHeight: 60,
    contentMaxWidth: 1360,
  },
});

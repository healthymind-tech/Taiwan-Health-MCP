import { Badge } from "@mantine/core";
import { IconHandClick, IconLink } from "@tabler/icons-react";
import type { IgInstallOrigin } from "./igTypes";

export const ORIGIN_LABEL: Record<IgInstallOrigin, string> = {
  manual: "手動安裝",
  dependency: "依賴安裝",
};

/** Install-origin badge: picked by an operator vs fetched for another IG. */
export function OriginBadge({ origin }: { origin: IgInstallOrigin }) {
  return origin === "manual" ? (
    <Badge variant="light" color="blue" leftSection={<IconHandClick size={11} />}>
      {ORIGIN_LABEL.manual}
    </Badge>
  ) : (
    <Badge variant="light" color="gray" leftSection={<IconLink size={11} />}>
      {ORIGIN_LABEL.dependency}
    </Badge>
  );
}

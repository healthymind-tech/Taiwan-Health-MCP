import { Button } from "@mantine/core";
import { IconMapOff } from "@tabler/icons-react";
import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={<IconMapOff size={28} />}
      title="找不到這個頁面"
      description="網址可能有誤，或頁面已搬移。"
      action={
        <Button component={Link} to="/">
          回到儀表板
        </Button>
      }
    />
  );
}

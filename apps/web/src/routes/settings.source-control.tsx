import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/source-control")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general" });
  },
});

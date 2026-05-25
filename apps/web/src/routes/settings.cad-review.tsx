import { createFileRoute } from "@tanstack/react-router";

import { CadReviewSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsCadReviewRoute() {
  return <CadReviewSettingsPanel />;
}

export const Route = createFileRoute("/settings/cad-review")({
  component: SettingsCadReviewRoute,
});

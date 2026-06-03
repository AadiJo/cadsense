import { MonitorIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export function ConnectionsSettings() {
  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border/70 bg-card/40 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md border border-border/70 bg-background p-2">
            <MonitorIcon aria-hidden className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-foreground">Local backend</h3>
              <Badge variant="secondary">Local only</Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              CadSense now runs against the local backend only. External environment connections and
              pairing links are no longer available.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

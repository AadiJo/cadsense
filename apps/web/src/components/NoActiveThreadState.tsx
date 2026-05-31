import { scopeThreadRef } from "@cadsense/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  FolderIcon,
  MessageSquareIcon,
} from "lucide-react";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { ProjectFavicon } from "./ProjectFavicon";
import { cn } from "~/lib/utils";
import { isProjectlessChatProject } from "../projectlessChat";

const RECENT_THREAD_LIMIT = 6;

type ConnectorStatus = "checking" | "connected" | "not-configured" | "unavailable";

interface ConnectorSummary {
  readonly status: ConnectorStatus;
  readonly count: number;
}

function defaultConnectorSummary(): ConnectorSummary {
  return { count: 0, status: "checking" };
}

function connectorLabel(summary: ConnectorSummary): string {
  if (summary.status === "checking") {
    return summary.count > 0 ? "Connected" : "Checking";
  }
  if (summary.status === "connected") return "Connected";
  return "Not connected";
}

function connectorTone(summary: ConnectorSummary): string {
  if (summary.status === "connected" || (summary.status === "checking" && summary.count > 0)) {
    return "text-emerald-500";
  }
  if (summary.status === "checking") return "text-amber-500";
  return "text-muted-foreground/55";
}

function ProjectIcon(props: {
  project: ReturnType<typeof selectProjectsAcrossEnvironments>[number] | null;
}) {
  if (!props.project) {
    return <FolderIcon className="size-4 text-muted-foreground/55" />;
  }

  if (props.project.externalContext?.provider === "onshape") {
    return <img src="/onshape.svg" alt="" className="size-4 shrink-0 rounded-sm object-contain" />;
  }

  if (isProjectlessChatProject(props.project)) {
    return <MessageSquareIcon className="size-4 text-muted-foreground/65" />;
  }

  return (
    <ProjectFavicon
      environmentId={props.project.environmentId}
      cwd={props.project.cwd}
      className="size-4"
    />
  );
}

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const appState = useStore((state) => state);
  const projects = useMemo(() => selectProjectsAcrossEnvironments(appState), [appState]);
  const regularProjects = useMemo(
    () => projects.filter((project) => !isProjectlessChatProject(project)),
    [projects],
  );
  const projectByKey = useMemo(() => {
    const entries = projects.map(
      (project) => [`${project.environmentId}:${project.id}`, project] as const,
    );
    return new Map<string, (typeof projects)[number]>(entries);
  }, [projects]);
  const allRecentThreads = useMemo(
    () =>
      sortThreads(
        selectSidebarThreadsAcrossEnvironments(appState).filter(
          (thread) => thread.archivedAt === null,
        ),
        "updated_at",
      ),
    [appState],
  );
  const chatThreads = useMemo(
    () =>
      allRecentThreads.filter((thread) =>
        isProjectlessChatProject(projectByKey.get(`${thread.environmentId}:${thread.projectId}`)),
      ),
    [allRecentThreads, projectByKey],
  );
  const chatCount = chatThreads.length;
  const recentChats = chatThreads.slice(0, RECENT_THREAD_LIMIT);
  const recentThreads = allRecentThreads.slice(0, RECENT_THREAD_LIMIT);
  const lastActiveThread = recentThreads[0] ?? null;
  const recentThreadsExcludingActive = useMemo(
    () =>
      lastActiveThread
        ? recentThreads.filter(
            (thread) =>
              thread.environmentId !== lastActiveThread.environmentId ||
              thread.id !== lastActiveThread.id,
          )
        : recentThreads,
    [lastActiveThread, recentThreads],
  );
  const lastActiveProject = lastActiveThread
    ? (projectByKey.get(`${lastActiveThread.environmentId}:${lastActiveThread.projectId}`) ?? null)
    : null;
  const lastActiveProjectLabel = isProjectlessChatProject(lastActiveProject)
    ? "Chat"
    : (lastActiveProject?.name ?? "Recent workspace");
  const [onshapeStatus, setOnshapeStatus] = useState<ConnectorSummary>(defaultConnectorSummary);
  const [mechbaseStatus, setMechbaseStatus] = useState<ConnectorSummary>(defaultConnectorSummary);

  useEffect(() => {
    let cancelled = false;
    setOnshapeStatus((current) => ({ ...current, status: "checking" }));
    setMechbaseStatus((current) => ({ ...current, status: "checking" }));

    if (primaryEnvironmentId === null) {
      setOnshapeStatus((current) => ({ ...current, status: "unavailable" }));
      setMechbaseStatus((current) => ({ ...current, status: "unavailable" }));
      return;
    }

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) {
      setOnshapeStatus((current) => ({ ...current, status: "unavailable" }));
      setMechbaseStatus((current) => ({ ...current, status: "unavailable" }));
      return;
    }

    void api.onshape
      .listConnections()
      .then((result) => {
        if (cancelled) return;
        setOnshapeStatus({
          count: result.connections.length,
          status: result.connections.length > 0 ? "connected" : "not-configured",
        });
      })
      .catch(() => {
        if (!cancelled) setOnshapeStatus((current) => ({ ...current, status: "unavailable" }));
      });

    void api.mechbase
      .listConnections()
      .then((result) => {
        if (cancelled) return;
        setMechbaseStatus({
          count: result.connections.length,
          status: result.connections.length > 0 ? "connected" : "not-configured",
        });
      })
      .catch(() => {
        if (!cancelled) setMechbaseStatus((current) => ({ ...current, status: "unavailable" }));
      });

    return () => {
      cancelled = true;
    };
  }, [primaryEnvironmentId]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[60px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <main className="flex min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_10%_0%,hsl(var(--accent)/0.24),transparent_26rem)] px-4 py-5 sm:px-8 lg:px-12">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-10 gap-y-9 self-start pt-[6vh] lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <section className="min-w-0">
              <div className="space-y-9">
                <section className="space-y-3">
                  <SectionLabel>Continue working</SectionLabel>
                  {lastActiveThread ? (
                    <button
                      type="button"
                      className="group grid w-full min-w-0 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md bg-muted/35 px-3 py-3 text-left transition-colors hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(lastActiveThread.environmentId, lastActiveThread.id),
                          ),
                        })
                      }
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60">
                        <ProjectIcon project={lastActiveProject} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {lastActiveProjectLabel}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">
                          {lastActiveThread.title} -{" "}
                          {formatRelativeTimeLabel(
                            lastActiveThread.latestUserMessageAt ??
                              lastActiveThread.updatedAt ??
                              lastActiveThread.createdAt,
                          )}
                        </span>
                      </span>
                      <ArrowRightIcon className="size-4 text-muted-foreground/45 transition-colors group-hover:text-foreground" />
                    </button>
                  ) : (
                    <p className="border-l border-border/80 py-1 pl-3 text-sm text-muted-foreground/72">
                      Start a chat or project thread and your latest work will appear here.
                    </p>
                  )}
                </section>

                <section className="space-y-3">
                  <SectionLabel>Recent chats</SectionLabel>
                  <div className="space-y-2.5">
                    {recentChats.length > 0 ? (
                      recentChats.slice(0, 4).map((thread) => (
                        <button
                          key={`${thread.environmentId}:${thread.id}`}
                          type="button"
                          className="group grid w-full min-w-0 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
                          onClick={() =>
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(thread.environmentId, thread.id),
                              ),
                            })
                          }
                        >
                          <MessageSquareIcon className="size-4 text-muted-foreground/65" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-foreground">
                              {thread.title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground/62">
                              {formatRelativeTimeLabel(
                                thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                              )}
                            </span>
                          </span>
                          <ChevronRightIcon className="size-4 text-muted-foreground/35 group-hover:text-muted-foreground/70" />
                        </button>
                      ))
                    ) : (
                      <p className="border-l border-border/80 py-1 pl-3 text-sm text-muted-foreground/72">
                        Chats will appear here after your first conversation.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </section>

            <aside className="space-y-8 border-border/70 lg:border-l lg:pl-8">
              <section>
                <SectionLabel>System status</SectionLabel>
                <div className="mt-4 space-y-4">
                  <ConnectorRow
                    icon={<img src="/onshape.svg" alt="" className="size-4 rounded-sm" />}
                    name="Onshape"
                    summary={onshapeStatus}
                  />
                  <ConnectorRow
                    icon={<MechbaseIcon className="size-4 text-foreground" />}
                    name="Mechbase"
                    summary={mechbaseStatus}
                  />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-6 border-t border-border/60 pt-5">
                  <Metric label="Projects" value={String(regularProjects.length)} />
                  <Metric label="Chats" value={String(chatCount)} />
                </div>
              </section>

              <section>
                <SectionLabel>Recent threads</SectionLabel>
                <div className="mt-3 space-y-1.5">
                  {recentThreadsExcludingActive.length > 0 ? (
                    recentThreadsExcludingActive.slice(0, 4).map((thread) => {
                      const project =
                        projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
                      return (
                        <button
                          key={`${thread.environmentId}:${thread.id}`}
                          type="button"
                          className="group grid w-full min-w-0 grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
                          onClick={() =>
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(thread.environmentId, thread.id),
                              ),
                            })
                          }
                        >
                          <ProjectIcon project={project} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-foreground">
                              {thread.title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground/62">
                              {isProjectlessChatProject(project)
                                ? "Chat"
                                : (project?.name ?? "Unknown project")}
                            </span>
                          </span>
                          <ChevronRightIcon className="size-4 text-muted-foreground/35 group-hover:text-muted-foreground/70" />
                        </button>
                      );
                    })
                  ) : (
                    <p className="px-2 py-2 text-sm text-muted-foreground/70">
                      Threads will appear after your first run.
                    </p>
                  )}
                </div>
              </section>
            </aside>
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function SectionLabel({ children }: { readonly children: string }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground/62">
      {children}
    </h2>
  );
}

function ConnectorRow({
  icon,
  name,
  summary,
}: {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly summary: ConnectorSummary;
}) {
  const connected = summary.status === "connected";
  const appearsConnected = connected || (summary.status === "checking" && summary.count > 0);
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
      <span className="flex size-7 items-center justify-center">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className={cn("block truncate text-xs", connectorTone(summary))}>
          {connectorLabel(summary)}
        </span>
      </span>
      {appearsConnected ? (
        <CircleCheckIcon className="size-4 text-emerald-500" />
      ) : (
        <CircleDashedIcon className={cn("size-4", connectorTone(summary))} />
      )}
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="text-lg font-semibold leading-none text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground/62">{label}</div>
    </div>
  );
}

function MechbaseIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="Mechbase"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
    >
      <path d="M24 18v-6h-6m0 6h12c3.31 0 6 2.69 6 6v6c0 3.31-2.69 6-6 6H18c-3.31 0-6-2.69-6-6v-6c0-3.31 2.69-6 6-6Zm-12 9H6m36 0h-6M19.5 25.5v3m9-3v3" />
    </svg>
  );
}

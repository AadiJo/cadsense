import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChevronRightIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { buildThreadRouteParams } from "../threadRoutes";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { ProjectFavicon } from "./ProjectFavicon";
import { cn } from "~/lib/utils";

const RECENT_THREAD_LIMIT = 8;

function ProjectIcon(props: {
  project: ReturnType<typeof selectProjectsAcrossEnvironments>[number] | null;
}) {
  if (!props.project) {
    return <FolderIcon className="size-4 text-muted-foreground/55" />;
  }

  if (props.project.externalContext?.provider === "onshape") {
    return <img src="/onshape.svg" alt="" className="size-4 shrink-0 rounded-sm object-contain" />;
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
  const { handleNewThread } = useNewThreadHandler();
  const appState = useStore((state) => state);
  const projects = useMemo(() => selectProjectsAcrossEnvironments(appState), [appState]);
  const recentThreads = useMemo(
    () =>
      sortThreads(
        selectSidebarThreadsAcrossEnvironments(appState).filter(
          (thread) => thread.archivedAt === null,
        ),
        "updated_at",
      ).slice(0, RECENT_THREAD_LIMIT),
    [appState],
  );
  const projectByKey = useMemo(() => {
    const entries = projects.map(
      (project) => [`${project.environmentId}:${project.id}`, project] as const,
    );
    return new Map<string, (typeof projects)[number]>(entries);
  }, [projects]);
  const reviewedThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [environmentId, environmentState] of Object.entries(appState.environmentStateById)) {
      for (const [threadId, reviewIds] of Object.entries(
        environmentState.reviewIdsByThreadId ?? {},
      )) {
        if (reviewIds.length > 0) {
          keys.add(`${environmentId}:${threadId}`);
        }
      }
    }
    for (const thread of recentThreads) {
      if (thread.hasActiveReview) {
        keys.add(`${thread.environmentId}:${thread.id}`);
      }
    }
    return keys;
  }, [appState.environmentStateById, recentThreads]);
  const recentProjectGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        project: (typeof projects)[number] | null;
        threads: typeof recentThreads;
      }
    >();

    for (const thread of recentThreads) {
      const key: string = `${thread.environmentId}:${thread.projectId}`;
      const current = groups.get(key);
      if (current) {
        current.threads.push(thread);
        continue;
      }
      groups.set(key, {
        project: projectByKey.get(key) ?? null,
        threads: [thread],
      });
    }

    return [...groups.entries()].map(([key, group]) => ({
      key,
      project: group.project,
      threads: group.threads,
    }));
  }, [projectByKey, recentThreads]);

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

        <main className="flex min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-10 lg:px-14">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 pt-[10vh]">
            <section className="space-y-2">
              <h1 className="max-w-3xl text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
                Pick up where you left off
              </h1>
              <p className="text-sm text-muted-foreground/58">Choose a recent project or thread.</p>
            </section>

            <section className="min-w-0">
              {recentProjectGroups.length > 0 ? (
                <div className="space-y-1.5">
                  {recentProjectGroups.map(({ key, project, threads }, groupIndex) => (
                    <div key={key} className={cn(groupIndex > 0 && "pt-2")}>
                      <button
                        type="button"
                        className="group grid w-full min-w-0 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
                        onClick={() => {
                          if (!project) return;
                          void handleNewThread(scopeProjectRef(project.environmentId, project.id));
                        }}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md">
                          <ProjectIcon project={project} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground">
                            {project?.name ?? "Unknown project"}
                          </span>
                        </span>
                        <ChevronRightIcon className="size-4 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70 group-focus-visible:text-muted-foreground/70" />
                      </button>

                      <div className="pb-1 pl-8 pr-1">
                        <div className="border-l border-border/55">
                          {threads.map((thread) => {
                            const timestamp = formatRelativeTimeLabel(
                              thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                            );
                            const hasReviewHistory = reviewedThreadKeys.has(
                              `${thread.environmentId}:${thread.id}`,
                            );

                            return (
                              <button
                                key={`${thread.environmentId}:${thread.id}`}
                                type="button"
                                className="group grid w-full min-w-0 grid-cols-[auto_auto_1fr] items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
                                onClick={() =>
                                  void navigate({
                                    to: "/$environmentId/$threadId",
                                    params: buildThreadRouteParams(
                                      scopeThreadRef(thread.environmentId, thread.id),
                                    ),
                                  })
                                }
                              >
                                <span className="-ml-px h-px w-4 bg-border/70" />
                                {hasReviewHistory ? (
                                  <FileTextIcon className="size-3.5 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground/70" />
                                ) : (
                                  <span className="size-3.5" />
                                )}
                                <span className="grid min-w-0 grid-cols-[1fr_auto] items-center gap-3">
                                  <span className="truncate text-sm text-muted-foreground/82 group-hover:text-foreground">
                                    {thread.title}
                                  </span>
                                  <span className="shrink-0 text-xs text-muted-foreground/45">
                                    {timestamp}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground/70">
                  Recent threads will appear here once you start working.
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

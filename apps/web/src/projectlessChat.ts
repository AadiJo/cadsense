import type { Project } from "./types";

export function isProjectlessChatProject(
  project: Pick<Project, "externalContext"> | null | undefined,
): boolean {
  return project?.externalContext?.provider === "chat";
}

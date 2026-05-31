import { EnvironmentId } from "@cadsense/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowCadPanelToggle, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        isProjectlessChat: false,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        isProjectlessChat: false,
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        isProjectlessChat: false,
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        isProjectlessChat: false,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker for projectless chats", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "Chats",
        isProjectlessChat: true,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("shouldShowCadPanelToggle", () => {
  it("shows the toggle for active projects", () => {
    expect(
      shouldShowCadPanelToggle({ activeProjectName: "Bracket", isProjectlessChat: false }),
    ).toBe(true);
  });

  it("hides the toggle when there is no active project", () => {
    expect(
      shouldShowCadPanelToggle({ activeProjectName: undefined, isProjectlessChat: false }),
    ).toBe(false);
  });

  it("hides the toggle for projectless chats", () => {
    expect(shouldShowCadPanelToggle({ activeProjectName: "Chats", isProjectlessChat: true })).toBe(
      false,
    );
  });
});

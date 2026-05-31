import { describe, expect, it } from "vitest";
import { deriveProjectGroupLabel, resolveProjectDisplayName } from "./logicalProject";
import type { Project } from "./types";

function makeOnshapeProject(
  overrides: Partial<Pick<Project, "name" | "externalContext">> = {},
): Pick<Project, "name" | "repositoryIdentity" | "externalContext"> {
  return {
    name: "Bracket Assembly",
    repositoryIdentity: null,
    externalContext: {
      provider: "onshape",
      onshape: {
        connectionId: "onshape_conn",
        entityId: "onshape_ent",
        entityKind: "part",
        name: "Bracket",
        breadcrumb: ["doc-123", "elem-456", "Bracket"],
        reference: {
          baseUrl: "https://cad.onshape.com",
          documentId: "doc-123",
        },
      },
    },
    ...overrides,
  };
}

describe("resolveProjectDisplayName", () => {
  it("prefers the project title over Onshape breadcrumb metadata", () => {
    const project = makeOnshapeProject({ name: "My renamed bracket" });
    expect(resolveProjectDisplayName(project)).toBe("My renamed bracket");
  });

  it("falls back to breadcrumb and entity name when the project title is empty", () => {
    const onshapeContext = makeOnshapeProject().externalContext;
    if (onshapeContext?.provider !== "onshape") {
      throw new Error("Expected Onshape test fixture.");
    }
    expect(resolveProjectDisplayName(makeOnshapeProject({ name: "   " }))).toBe(
      "doc-123 > elem-456 > Bracket",
    );
    expect(
      resolveProjectDisplayName(
        makeOnshapeProject({
          name: "",
          externalContext: {
            provider: "onshape",
            onshape: {
              ...onshapeContext.onshape,
              breadcrumb: [],
            },
          },
        }),
      ),
    ).toBe("Bracket");
  });

  it("labels hidden projectless chat projects as chats", () => {
    expect(
      resolveProjectDisplayName({
        name: "",
        externalContext: { provider: "chat" },
      }),
    ).toBe("Chats");
  });
});

describe("deriveProjectGroupLabel", () => {
  it("uses renamed Onshape project titles for grouped labels", () => {
    const member = makeOnshapeProject({ name: "Shared renamed title" });
    expect(
      deriveProjectGroupLabel({
        representative: member,
        members: [member],
      }),
    ).toBe("Shared renamed title");
  });
});

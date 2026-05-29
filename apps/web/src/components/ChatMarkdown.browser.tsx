import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { openInPreferredEditorMock, readLocalApiMock } = vi.hoisted(() => ({
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  readLocalApiMock: vi.fn(() => ({
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: { openInEditor: vi.fn(async () => undefined) },
  })),
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });
  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath =
      "/Users/yashsingh/p/cadsense/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/cadsense/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("renders markdown image URLs and sends them to the expanded preview", async () => {
    const onImageExpand = vi.fn();
    const screen = await render(
      <ChatMarkdown
        text="![Shooter reference](/favicon-32x32.png)"
        cwd="/repo/project"
        onImageExpand={onImageExpand}
      />,
    );

    try {
      const image = page.getByRole("img", { name: "Shooter reference" });
      await expect.element(image).toBeVisible();
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/favicon-32x32.png");

      await page.getByRole("button", { name: "Expand image: Shooter reference" }).click();
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [{ src: "/favicon-32x32.png", name: "Shooter reference" }],
        index: 0,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("routes Mechbase artifact image URLs through the authenticated preview endpoint", async () => {
    const artifactUrl = "https://api-frcrag-v2.johari-dev.com/images/254-2020/page-015/page.png";
    const expectedPreviewUrl = `/api/mechbase/artifact?artifactUrl=${encodeURIComponent(artifactUrl)}`;
    const screen = await render(
      <ChatMarkdown text={`![Mechbase page](${artifactUrl})`} cwd="/repo/project" />,
    );

    try {
      const image = document.querySelector("img[alt='Mechbase page']");
      expect(image?.getAttribute("src")).toBe(expectedPreviewUrl);
    } finally {
      await screen.unmount();
    }
  });

  it("does not render Mechbase artifact source links as clickable hyperlinks", async () => {
    const artifactUrl =
      "https://api-frcrag-v2.johari-dev.com/images/254-2020/page-022/image-001.jpeg";
    const screen = await render(
      <ChatMarkdown
        text={`[Open image source: Efficient FRC shooter reference](${artifactUrl})`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByText("Image preview unavailable: Efficient FRC shooter reference"))
        .toBeVisible();
      expect(document.querySelector(`a[href="${artifactUrl}"]`)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("renders Mechbase source citations as team-year plain text because direct API URLs are not browser links", async () => {
    const sourceUrl = "https://api-frcrag-v2.johari-dev.com/pages/254-2020.pdf/22";
    const screen = await render(
      <ChatMarkdown
        text={`Source: [Team 254, 2020 technical binder, page 22](${sourceUrl})`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect.element(page.getByText("FRC 254 in 2020, page 22")).toBeVisible();
      expect(document.querySelector(`a[href="${sourceUrl}"]`)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("formats bare Mechbase page URLs as FRC team-year citations", async () => {
    const sourceUrl = "https://api-frcrag-v2.johari-dev.com/pages/254-2017.pdf/17";
    const screen = await render(<ChatMarkdown text={`Source: ${sourceUrl}`} cwd="/repo/project" />);

    try {
      await expect.element(page.getByText("FRC 254 in 2017, page 17")).toBeVisible();
      expect(document.body.textContent).not.toContain(sourceUrl);
      expect(document.querySelector(`a[href="${sourceUrl}"]`)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("blocks unsafe markdown image URLs instead of rendering them", async () => {
    const screen = await render(
      <ChatMarkdown text="![Unexpected](data:image/svg+xml;base64,PHN2Zy8+)" cwd="/repo/project" />,
    );

    try {
      await expect.element(page.getByText("Image blocked")).toBeVisible();
      expect(document.querySelector("img")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

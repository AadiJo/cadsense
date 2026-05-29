// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  fetchMechbaseArtifact,
  MECHBASE_API_KEY_ENV,
  MECHBASE_PUBLIC_API_BASE_URL,
  normalizeMechbaseSearchInput,
  searchMechbase,
  validateMechbaseApiKey,
} from "./MechbaseApi.ts";
import {
  MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME,
  MECHBASE_MCP_SEARCH_TOOL_NAME,
  MECHBASE_MCP_SERVER_NAME,
  handleMechbaseMcpRequest,
  makeMechbaseCodexMcpConfig,
  makeMechbaseMcpStdioServer,
} from "./MechbaseMcp.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function binaryResponse(
  body: Uint8Array,
  init?: { readonly status?: number; readonly contentType?: string },
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "content-type": init?.contentType ?? "image/png",
      "content-length": String(body.byteLength),
    },
  });
}

const JPEG_2000_2X2_RED_FIXTURE = Buffer.from(
  "AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAAgAAAAIAAwcHAAAAAAAPY29scgEAAAAAABAAAACYanAyY/9P/1EALwAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAEEBAAB/1wAB0BASEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAHQAB/5PPtAQA34AIB9+ACAeAgID/2Q==",
  "base64",
);

describe("MechbaseApi", () => {
  it("validates API keys through Mechbase", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        apiKeyId: "key_1",
        workspaceId: "workspace_1",
        permissions: ["search:read"],
      }),
    );

    await expect(validateMechbaseApiKey("secret", fetchImpl)).resolves.toMatchObject({
      valid: true,
      apiKeyId: "key_1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${MECHBASE_PUBLIC_API_BASE_URL}/auth/validate`, {
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("rejects keys without search permission", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        apiKeyId: "key_1",
        workspaceId: "workspace_1",
        permissions: [],
      }),
    );

    await expect(validateMechbaseApiKey("secret", fetchImpl)).rejects.toThrow("search:read");
  });

  it("normalizes search input", () => {
    expect(
      normalizeMechbaseSearchInput({
        query: " swerve module ",
        top_k: 5,
        team: " 254 ",
        year: 2024,
        modality: "text",
      }),
    ).toEqual({
      query: "swerve module",
      top_k: 5,
      team: "254",
      year: 2024,
      modality: "text",
    });
    expect(() => normalizeMechbaseSearchInput({ query: "x", top_k: 101 })).toThrow("top_k");
  });

  it("searches Mechbase and resolves relative URLs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            source_pdf: "254-2020.pdf",
            page: 15,
            artifact_url: "/images/254-2020/page-015/page.png",
            linked_artifact_urls: ["/images/254-2020/page-015/extracted.png"],
          },
        ],
      }),
    );

    const result = await searchMechbase({ query: "shooter", top_k: 1 }, "secret", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(`${MECHBASE_PUBLIC_API_BASE_URL}/search`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "shooter", top_k: 1 }),
    });
    expect(result.results?.[0]?.artifact_url).toBe(
      `${MECHBASE_PUBLIC_API_BASE_URL}/images/254-2020/page-015/page.png`,
    );
  });

  it("fetches image artifacts from Mechbase URLs", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn().mockResolvedValue(binaryResponse(bytes));
    const artifactUrl = `${MECHBASE_PUBLIC_API_BASE_URL}/images/254-2020/page-015/page.png`;

    const result = await fetchMechbaseArtifact({ artifactUrl }, "secret", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(artifactUrl, {
      headers: { Authorization: "Bearer secret" },
    });
    expect(result).toMatchObject({
      artifactUrl,
      mimeType: "image/png",
      sizeBytes: 3,
    });
    expect([...result.data]).toEqual([1, 2, 3]);
  });

  it("converts non-browser-previewable Mechbase image artifacts to PNG", async () => {
    const bytes = new Uint8Array(
      await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .tiff()
        .toBuffer(),
    );
    const fetchImpl = vi.fn().mockResolvedValue(
      binaryResponse(bytes, {
        contentType: "application/octet-stream",
      }),
    );
    const artifactUrl = `${MECHBASE_PUBLIC_API_BASE_URL}/images/254-2020/page-015/image-001.tiff`;

    const result = await fetchMechbaseArtifact({ artifactUrl }, "secret", fetchImpl);

    expect(result).toMatchObject({
      artifactUrl,
      mimeType: "image/png",
    });
    expect(result.sizeBytes).toBeGreaterThan(3);
    const metadata = await sharp(result.data).metadata();
    expect(metadata.format).toBe("png");
  });

  it("converts JPEG 2000 Mechbase image artifacts to PNG", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      binaryResponse(JPEG_2000_2X2_RED_FIXTURE, {
        contentType: "image/jpx",
      }),
    );
    const artifactUrl = `${MECHBASE_PUBLIC_API_BASE_URL}/images/254-2024/page-014/image-000.jpx`;

    const result = await fetchMechbaseArtifact({ artifactUrl }, "secret", fetchImpl);

    expect(result).toMatchObject({
      artifactUrl,
      mimeType: "image/png",
    });
    const metadata = await sharp(result.data).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
  });

  it("rejects artifact fetches outside the Mechbase API origin", async () => {
    await expect(
      fetchMechbaseArtifact({ artifactUrl: "https://example.com/page.png" }, "secret", vi.fn()),
    ).rejects.toThrow("configured Mechbase API origin");
  });

  it("rejects non-image artifact fetches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      binaryResponse(new Uint8Array([1, 2, 3]), {
        contentType: "application/json",
      }),
    );

    await expect(
      fetchMechbaseArtifact(
        { artifactUrl: `${MECHBASE_PUBLIC_API_BASE_URL}/context/page.json` },
        "secret",
        fetchImpl,
      ),
    ).rejects.toThrow("not an image");
  });
});

describe("MechbaseMcp", () => {
  it("builds stdio server descriptors", () => {
    const server = makeMechbaseMcpStdioServer("secret");
    expect(server.name).toBe(MECHBASE_MCP_SERVER_NAME);
    expect(server.command).toBe(process.execPath);
    expect(server.args).toContain("mcp");
    expect(server.args).toContain("mechbase");
    expect(server.env).toContainEqual({ name: MECHBASE_API_KEY_ENV, value: "secret" });
  });

  it("projects Codex mcp_servers config", () => {
    expect(makeMechbaseCodexMcpConfig("secret")).toMatchObject({
      mcp_servers: {
        [MECHBASE_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: expect.arrayContaining(["mcp", "mechbase"]),
          env: { [MECHBASE_API_KEY_ENV]: "secret" },
        },
      },
    });
  });

  it("lists the search tool", async () => {
    const response = await handleMechbaseMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
    const tools = (response as { result: { tools: { name: string; description?: string }[] } })
      .result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      MECHBASE_MCP_SEARCH_TOOL_NAME,
      MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME,
    ]);
    const descriptions = tools.map((tool) => tool.description ?? "").join("\n");
    expect(descriptions).toContain("Markdown image syntax");
    expect(descriptions).toContain("Source: FRC 254 in 2020, page 22");
  });

  it("handles search tool calls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{ team: "254" }] }));

    const response = await handleMechbaseMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: MECHBASE_MCP_SEARCH_TOOL_NAME,
          arguments: { query: "swerve", top_k: 1 },
        },
      },
      { apiKey: "secret", fetch: fetchImpl },
    );

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 2 });
    const text = (response as { result: { content: { text: string }[] } }).result.content[0]?.text;
    expect(text).toContain('"team": "254"');
  });

  it("handles artifact fetch tool calls with image content", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn().mockResolvedValue(binaryResponse(bytes));
    const artifactUrl = `${MECHBASE_PUBLIC_API_BASE_URL}/images/254-2020/page-015/page.png`;
    const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cadsense-mechbase-mcp-"));

    try {
      const response = await handleMechbaseMcpRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME,
            arguments: { artifactUrl },
          },
        },
        { apiKey: "secret", fetch: fetchImpl, artifactDirectory },
      );

      expect(response).toMatchObject({ jsonrpc: "2.0", id: 3 });
      const content = (
        response as {
          result: {
            content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
          };
        }
      ).result.content;
      expect(content[0]?.text).toContain("saved locally");
      const metadata = JSON.parse(content[0]?.text ?? "{}") as { localPath?: string };
      expect(metadata.localPath).toContain(artifactDirectory);
      expect(metadata.localPath).toMatch(/\.png$/);
      expect(metadata.localPath ? fs.existsSync(metadata.localPath) : false).toBe(true);
      expect(metadata.localPath ? [...fs.readFileSync(metadata.localPath)] : []).toEqual([1, 2, 3]);
      expect(content[1]).toMatchObject({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "image/png",
      });
    } finally {
      fs.rmSync(artifactDirectory, { recursive: true, force: true });
    }
  });
});

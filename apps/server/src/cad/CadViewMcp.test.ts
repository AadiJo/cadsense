import { describe, expect, it, vi } from "vitest";

import {
  CAD_VIEW_EXPORT_ROOT_ENV,
  CAD_VIEW_MCP_SERVER_NAME,
  CAD_VIEW_MCP_TOOL_NAME,
  handleCadViewMcpRequest,
  makeCadViewCodexMcpConfig,
  makeCadViewMcpOrigin,
  makeCadViewMcpStdioServer,
} from "./CadViewMcp.ts";

describe("CadViewMcp", () => {
  it("builds loopback origin for wildcard hosts", () => {
    expect(makeCadViewMcpOrigin({ host: "0.0.0.0", port: 3900 })).toBe("http://127.0.0.1:3900");
  });

  it("builds stdio server descriptors with command environment", () => {
    const server = makeCadViewMcpStdioServer({ host: "localhost", port: 3900 });
    expect(server.name).toBe(CAD_VIEW_MCP_SERVER_NAME);
    expect(server.command).toBe(process.execPath);
    expect(server.args).toContain("mcp");
    expect(server.args).toContain("cad-view");
    expect(server.env.some((entry) => entry.name === "CADSENSE_CAD_VIEW_ORIGIN")).toBe(true);
    expect(server.env.some((entry) => entry.name === "CADSENSE_CAD_VIEW_TOKEN")).toBe(true);
  });

  it("includes export root in MCP env when provided", () => {
    const server = makeCadViewMcpStdioServer(
      { host: "localhost", port: 3900 },
      undefined,
      "/tmp/cadsense",
    );
    expect(server.env.find((e) => e.name === CAD_VIEW_EXPORT_ROOT_ENV)?.value).toBe(
      "/tmp/cadsense",
    );
  });

  it("propagates ELECTRON_RUN_AS_NODE when the server runs under Electron", () => {
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const server = makeCadViewMcpStdioServer({ host: "localhost", port: 3900 });
      expect(server.env.find((entry) => entry.name === "ELECTRON_RUN_AS_NODE")?.value).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previous;
      }
    }
  });

  it("omits ELECTRON_RUN_AS_NODE outside of Electron-as-node parents", () => {
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    try {
      const server = makeCadViewMcpStdioServer({ host: "localhost", port: 3900 });
      expect(server.env.some((entry) => entry.name === "ELECTRON_RUN_AS_NODE")).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.ELECTRON_RUN_AS_NODE = previous;
      }
    }
  });

  it("projects Codex mcp_servers config", () => {
    expect(makeCadViewCodexMcpConfig({ host: undefined, port: 3900 })).toMatchObject({
      mcp_servers: {
        [CAD_VIEW_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: expect.arrayContaining(["mcp", "cad-view"]),
          env: {
            CADSENSE_CAD_VIEW_ORIGIN: "http://127.0.0.1:3900",
          },
        },
      },
    });
  });

  it("handles MCP tool calls", async () => {
    const setView = vi.fn().mockResolvedValue(undefined);
    const sendControl = vi.fn().mockResolvedValue(undefined);
    const getHierarchy = vi.fn().mockResolvedValue({ components: [] });
    const captureScreenshot = vi.fn();
    const response = await handleCadViewMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: CAD_VIEW_MCP_TOOL_NAME,
          arguments: { threadId: "thread-1", view: "top", fit: true },
        },
      },
      { setView, sendControl, getHierarchy, captureScreenshot },
    );

    expect(setView).toHaveBeenCalledWith({ threadId: "thread-1", view: "top", fit: true });
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "CAD view set to top." }] },
    });
  });

  it("handles free camera MCP tool calls", async () => {
    const setView = vi.fn().mockResolvedValue(undefined);
    const sendControl = vi.fn().mockResolvedValue(undefined);
    const getHierarchy = vi.fn().mockResolvedValue({ components: [] });
    const captureScreenshot = vi.fn();
    const response = await handleCadViewMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "set_cad_camera",
          arguments: {
            threadId: "thread-1",
            direction: [0.7, -1, 0.35],
            up: [0, 0, 1],
            fit: true,
            closeUp: false,
          },
        },
      },
      { setView, sendControl, getHierarchy, captureScreenshot },
    );

    expect(setView).not.toHaveBeenCalled();
    expect(sendControl).toHaveBeenCalledWith({
      type: "set-camera",
      threadId: "thread-1",
      direction: [0.7, -1, 0.35],
      up: [0, 0, 1],
      fit: true,
      closeUp: false,
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "CAD camera set to direction [0.7, -1, 0.35]." }] },
    });
  });

  it("lists two tools", async () => {
    const response = await handleCadViewMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        setView: vi.fn(),
        sendControl: vi.fn(),
        getHierarchy: vi.fn().mockResolvedValue({ components: [] }),
        captureScreenshot: vi.fn(),
      },
    );
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 2 });
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "set_cad_view",
      "set_cad_camera",
      "export_cad_screenshot",
      "get_cad_hierarchy",
      "set_cad_component_visibility",
      "set_cad_exploded",
      "zoom_cad_to_fit",
    ]);
  });
});

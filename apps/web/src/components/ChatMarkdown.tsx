import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import type { ServerProviderSkill } from "@cadsense/contracts";
import React, {
  Children,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import {
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onImageExpand?: (preview: ExpandedImagePreview) => void;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const MAX_MERMAID_CACHE_ENTRIES = 100;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 10 * 1024 * 1024;
const MERMAID_MIN_ZOOM = 0.5;
const MERMAID_MAX_ZOOM = 3;
const MERMAID_ZOOM_STEP = 0.2;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const mermaidSvgCache = new LRUCache<string>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function markdownAstNodeToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") {
    return record.value;
  }
  if (Array.isArray(record.children)) {
    return record.children.map((child) => markdownAstNodeToPlainText(child)).join("");
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function createMermaidCacheKey(code: string, theme: "light" | "dark"): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${theme}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function estimateMermaidSvgSize(svg: string, code: string): number {
  return Math.max(svg.length * 2, code.length * 3);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function getMermaidPromise(): Promise<typeof import("mermaid").default> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  if (isStreaming) {
    return (
      <pre className={cn("chat-markdown-streaming-code", className)}>
        <code>{code}</code>
      </pre>
    );
  }

  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

interface MermaidCodeBlockProps {
  code: string;
  theme: "light" | "dark";
  isStreaming: boolean;
}

function MermaidCodeBlock({ code, theme, isStreaming }: MermaidCodeBlockProps) {
  const renderId = useId();
  const panStateRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [svg, setSvg] = useState<string | null>(() => {
    if (isStreaming) return null;
    return mermaidSvgCache.get(createMermaidCacheKey(code, theme)) ?? null;
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ scale: 1, x: 0, y: 0 });
  const normalizedRenderId = `chat-mermaid-${renderId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const canZoomOut = viewport.scale > MERMAID_MIN_ZOOM;
  const canZoomIn = viewport.scale < MERMAID_MAX_ZOOM;
  const hasViewportTransform = viewport.scale !== 1 || viewport.x !== 0 || viewport.y !== 0;

  const updateScale = useCallback((delta: number) => {
    setViewport((current) => ({
      ...current,
      scale: clampNumber(current.scale + delta, MERMAID_MIN_ZOOM, MERMAID_MAX_ZOOM),
    }));
  }, []);

  const resetViewport = useCallback(() => {
    panStateRef.current = null;
    setViewport({ scale: 1, x: 0, y: 0 });
  }, []);

  const handleViewportWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const direction = event.deltaY > 0 ? -MERMAID_ZOOM_STEP : MERMAID_ZOOM_STEP;
      updateScale(direction);
    },
    [updateScale],
  );

  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStateRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, []);

  const handleViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - panState.x;
    const deltaY = event.clientY - panState.y;
    panStateRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setViewport((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  }, []);

  const stopViewportPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panStateRef.current?.pointerId === event.pointerId) {
      panStateRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isStreaming) {
      setSvg(null);
      setErrorMessage(null);
      return;
    }

    const cacheKey = createMermaidCacheKey(code, theme);
    const cachedSvg = mermaidSvgCache.get(cacheKey);
    if (cachedSvg != null) {
      setSvg(cachedSvg);
      setErrorMessage(null);
      return;
    }

    let cancelled = false;
    setSvg(null);
    setErrorMessage(null);

    void getMermaidPromise()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        const result = await mermaid.render(normalizedRenderId, code);
        if (cancelled) return;
        mermaidSvgCache.set(cacheKey, result.svg, estimateMermaidSvgSize(result.svg, code));
        setSvg(result.svg);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Could not render Mermaid diagram.";
        setErrorMessage(message);
      });

    return () => {
      cancelled = true;
    };
  }, [code, isStreaming, normalizedRenderId, theme]);

  useEffect(() => {
    resetViewport();
  }, [code, resetViewport, theme]);

  if (isStreaming) {
    return (
      <pre className="chat-markdown-streaming-code language-mermaid">
        <code>{code}</code>
      </pre>
    );
  }

  if (errorMessage) {
    return (
      <div className="chat-markdown-mermaid-error" role="note">
        <span>Mermaid diagram could not be rendered.</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="chat-markdown-mermaid-loading" role="status" aria-label="Rendering diagram" />
    );
  }

  return (
    <div className="chat-markdown-mermaid-shell">
      <div className="chat-markdown-mermaid-toolbar" aria-label="Mermaid diagram controls">
        <button
          type="button"
          className="chat-markdown-mermaid-tool-button"
          onClick={() => updateScale(MERMAID_ZOOM_STEP)}
          disabled={!canZoomIn}
          title="Zoom in"
          aria-label="Zoom in diagram"
        >
          <PlusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="chat-markdown-mermaid-tool-button"
          onClick={() => updateScale(-MERMAID_ZOOM_STEP)}
          disabled={!canZoomOut}
          title="Zoom out"
          aria-label="Zoom out diagram"
        >
          <MinusIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="chat-markdown-mermaid-tool-button"
          onClick={resetViewport}
          disabled={!hasViewportTransform}
          title="Reset view"
          aria-label="Reset diagram view"
        >
          <RotateCcwIcon className="size-3.5" />
        </button>
      </div>
      <div
        className="chat-markdown-mermaid"
        onWheel={handleViewportWheel}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={stopViewportPan}
        onPointerCancel={stopViewportPan}
      >
        <div
          className="chat-markdown-mermaid-canvas"
          style={{
            transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MECHBASE_API_URL_PATTERN = /^https:\/\/api-frcrag-v2\.johari-dev\.com\//i;
const MECHBASE_ARTIFACT_URL_PATTERN = /^https:\/\/api-frcrag-v2\.johari-dev\.com\/images\//i;
const MECHBASE_PAGE_SOURCE_URL_PATTERN =
  /^https:\/\/api-frcrag-v2\.johari-dev\.com\/pages\/(\d+)-(\d{4})\.pdf\/(\d+)/i;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

function isSafeMarkdownImageUrl(src: string): boolean {
  if (src.startsWith("/")) {
    return true;
  }

  try {
    const url = new URL(src);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isMechbaseApiUrl(href: string): boolean {
  return MECHBASE_API_URL_PATTERN.test(href);
}

function isMechbaseArtifactUrl(href: string): boolean {
  return MECHBASE_ARTIFACT_URL_PATTERN.test(href);
}

function formatMechbaseSourceCitation(href: string, children: ReactNode): string {
  const pageMatch = href.match(MECHBASE_PAGE_SOURCE_URL_PATTERN);
  if (pageMatch) {
    const [, team, year, page] = pageMatch;
    return `FRC ${team} in ${year}, page ${page}`;
  }

  const label = nodeToPlainText(children).trim();
  if (label && !isMechbaseApiUrl(label)) {
    return label;
  }

  return "Mechbase source";
}

function toMarkdownImagePreviewUrl(src: string): string {
  if (isMechbaseArtifactUrl(src)) {
    return `/api/mechbase/artifact?artifactUrl=${encodeURIComponent(src)}`;
  }
  return src;
}

function cleanMarkdownImageLinkLabel(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^open\s+image\s+source\s*:?\s*/i, "")
    .replace(/^image\s+source\s*:?\s*/i, "");
}

function markdownImageLabelFromLinkText(children: ReactNode, node: unknown): string {
  const label = cleanMarkdownImageLinkLabel(nodeToPlainText(children));
  if (label) {
    return label;
  }
  const nodeLabel = cleanMarkdownImageLinkLabel(markdownAstNodeToPlainText(node));
  if (nodeLabel) {
    return nodeLabel;
  }
  return label || "Image";
}

function MarkdownImage({
  src,
  alt,
  onImageExpand,
}: {
  src: string | undefined;
  alt: string | undefined;
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const safeSrc = typeof src === "string" && isSafeMarkdownImageUrl(src) ? src : "";
  const previewSrc = safeSrc ? toMarkdownImagePreviewUrl(safeSrc) : "";
  const imageLabel = alt?.trim() || "Image";

  useEffect(() => {
    setFailed(false);
  }, [previewSrc]);

  if (!previewSrc || failed) {
    if (!safeSrc) {
      return (
        <span className="chat-markdown-image-fallback" role="note">
          Image blocked
        </span>
      );
    }
    if (isMechbaseApiUrl(safeSrc)) {
      return (
        <span className="chat-markdown-image-fallback" role="note">
          Image preview unavailable: {imageLabel}
        </span>
      );
    }

    return (
      <a href={safeSrc} target="_blank" rel="noopener noreferrer">
        {failed ? `Open image source: ${imageLabel}` : imageLabel}
      </a>
    );
  }

  const image = (
    <img
      src={previewSrc}
      alt={imageLabel}
      className="chat-markdown-image"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      draggable={false}
    />
  );

  return (
    <span className="chat-markdown-image-frame">
      {onImageExpand ? (
        <button
          type="button"
          className="chat-markdown-image-button"
          aria-label={`Expand image: ${imageLabel}`}
          onClick={() =>
            onImageExpand({
              images: [{ src: previewSrc, name: imageLabel }],
              index: 0,
            })
          }
        >
          {image}
        </button>
      ) : (
        <a href={safeSrc} target="_blank" rel="noopener noreferrer">
          {image}
        </a>
      )}
      {alt?.trim() ? <span className="chat-markdown-image-caption">{alt.trim()}</span> : null}
    </span>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  label,
  theme,
  className,
}: MarkdownFileLinkProps) {
  const handleOpen = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    void openInPreferredEditor(api, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [targetPath]);

  const handleCopy = useCallback((value: string, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: value,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "open", label: "Open in editor" },
          { id: "copy-relative", label: "Copy relative path" },
          { id: "copy-full", label: "Copy full path" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "open") {
        handleOpen();
        return;
      }
      if (clicked === "copy-relative") {
        handleCopy(displayPath, "Relative path");
        return;
      }
      if (clicked === "copy-full") {
        handleCopy(targetPath, "Full path");
      }
    },
    [displayPath, handleCopy, handleOpen, targetPath],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleOpen();
            }}
            onContextMenu={handleContextMenu}
          >
            <VscodeEntryIcon
              pathValue={filePath}
              kind="file"
              theme={theme}
              className={cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current")}
            />
            <span className={MARKDOWN_FILE_LINK_LABEL_CLASS_NAME}>{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.filePath === next.filePath &&
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className
  );
}

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onImageExpand,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      li({ node: _node, children, ...props }) {
        return <li {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</li>;
      },
      a({ node, href, children, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
        if (!fileLinkMeta && normalizedHref && isMechbaseArtifactUrl(normalizedHref)) {
          return (
            <MarkdownImage
              src={normalizedHref}
              alt={markdownImageLabelFromLinkText(children, node)}
              onImageExpand={onImageExpand}
            />
          );
        }
        if (!fileLinkMeta && normalizedHref && isMechbaseApiUrl(normalizedHref)) {
          return (
            <span className="chat-markdown-source-text" title="Mechbase source citation">
              {formatMechbaseSourceCitation(normalizedHref, children)}
            </span>
          );
        }
        if (!fileLinkMeta) {
          return (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (fileLinkMeta.line) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={fileLinkMeta.targetPath}
            targetPath={fileLinkMeta.targetPath}
            displayPath={fileLinkMeta.displayPath}
            filePath={fileLinkMeta.filePath}
            label={labelParts.join(" · ")}
            theme={resolvedTheme}
            className={props.className}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }
        const language = extractFenceLanguage(codeBlock.className);

        if (MERMAID_LANGUAGES.has(language)) {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <MermaidCodeBlock
                code={codeBlock.code}
                theme={resolvedTheme}
                isStreaming={isStreaming}
              />
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
      img({ node: _node, src, alt }) {
        return <MarkdownImage src={src} alt={alt} onImageExpand={onImageExpand} />;
      },
    }),
    [
      diffThemeName,
      fileLinkParentSuffixByPath,
      isStreaming,
      markdownFileLinkMetaByHref,
      onImageExpand,
      resolvedTheme,
      skills,
    ],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);

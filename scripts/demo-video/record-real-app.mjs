import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const requireFromWeb = createRequire(path.join(repoRoot, "apps/web/package.json"));
const { chromium } = requireFromWeb("playwright");
const { default: ffmpegPath } = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "node_modules/.bun/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/index.js",
    ),
  ).href
);

const APP_URL = "http://localhost:5733";
const THREAD_ID = "23a11936-433f-4ccc-af3e-b80ff498af12";
const workDir = path.join(__dirname, "out-real");
const rawDir = path.join(workDir, "raw-video");
const extractedDir = path.join(workDir, "extracted");
const raw60Mp4 = path.join(workDir, "raw-60.mp4");
const FPS = 60;
const SRC_W = 2560;
const SRC_H = 1440;

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function createPairing() {
  const output = execFileSync(
    "node",
    [
      "apps/server/src/bin.ts",
      "auth",
      "pairing",
      "create",
      "--dev-url",
      APP_URL,
      "--base-url",
      APP_URL,
      "--json",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return JSON.parse(output);
}

async function moveCursor(page, x, y, duration = 260) {
  await page.evaluate(
    ({ x, y, duration }) => {
      window.__demoMoveCursor?.(x, y, duration);
    },
    { x, y, duration },
  );
  await page.mouse.move(x, y, { steps: Math.max(8, Math.round(duration / 16)) });
  await page.waitForTimeout(duration);
}

async function smoothScrollAt(page, x, y, delta, duration = 650) {
  await page.evaluate(
    ({ x, y, delta, duration }) =>
      new Promise((resolve) => {
        const startAt = performance.now();
        let element = document.elementFromPoint(x, y);
        while (element && element !== document.body) {
          const style = window.getComputedStyle(element);
          const scrollable =
            element.scrollHeight > element.clientHeight &&
            ["auto", "scroll", "overlay"].includes(style.overflowY);
          if (scrollable) break;
          element = element.parentElement;
        }
        const scroller = element ?? document.scrollingElement ?? document.documentElement;
        const startTop = scroller.scrollTop;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const targetTop = Math.max(0, Math.min(maxTop, startTop + delta));
        const step = (now) => {
          const t = Math.min(1, (now - startAt) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          scroller.scrollTop = startTop + (targetTop - startTop) * eased;
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            resolve(undefined);
          }
        };
        requestAnimationFrame(step);
      }),
    { x, y, delta, duration },
  );
}

async function waitForRealThread(page) {
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("E2E CAD Review Smoke") &&
      document.body.innerText.includes("VR26A-0000 Main / E2E CAD Review Smoke CAD Review"),
    null,
    { timeout: 20_000 },
  );
}

async function scrollLatestReviewIntoView(page) {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const titleMatches = [];
    const fallbackMatches = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      const element = node.parentElement;
      if (!element) continue;
      if (text.includes("VR26A-0000 Main / E2E CAD Review Smoke CAD Review")) {
        titleMatches.push(element);
      }
      if (text.includes("program_readiness")) {
        fallbackMatches.push(element);
      }
    }
    const target = titleMatches.at(-1) ?? fallbackMatches.at(-1);
    target?.scrollIntoView({ block: "start", inline: "nearest" });
  });
}

await fs.rm(workDir, { recursive: true, force: true });
await fs.mkdir(rawDir, { recursive: true });
await fs.mkdir(extractedDir, { recursive: true });

const pairing = createPairing();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: SRC_W, height: SRC_H },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  recordVideo: { dir: rawDir, size: { width: SRC_W, height: SRC_H } },
});
const page = await context.newPage();
await page.goto(pairing.pairUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => location.pathname.split("/").filter(Boolean).length >= 2, null, {
  timeout: 15_000,
});
const environmentId = new URL(page.url()).pathname.split("/").find(Boolean);
if (!environmentId) throw new Error(`Pairing did not produce an environment route: ${page.url()}`);

await page.goto(`${APP_URL}/${environmentId}/${THREAD_ID}`, { waitUntil: "domcontentloaded" });
await waitForRealThread(page);
await page.waitForTimeout(900);

await page.addStyleTag({
  content: `
    * { caret-color: #8aa4ff !important; }
    #demo-cursor {
      position: fixed;
      left: 0;
      top: 0;
      width: 26px;
      height: 38px;
      z-index: 999999;
      pointer-events: none;
      filter: drop-shadow(0 4px 8px rgba(0,0,0,.55));
      transition: transform 160ms cubic-bezier(.2,.8,.2,1);
    }
  `,
});
await page.evaluate(() => {
  const cursor = document.createElement("div");
  cursor.id = "demo-cursor";
  cursor.innerHTML = `<svg viewBox="0 0 32 44" width="32" height="44" xmlns="http://www.w3.org/2000/svg"><path d="M4 3v31l8-7 6 13 8-4-6-12h11L4 3z" fill="#f4f7f4" stroke="#050606" stroke-width="2"/></svg>`;
  document.body.append(cursor);
  window.__demoMoveCursor = (x, y, duration = 250) => {
    cursor.style.transitionDuration = `${duration}ms`;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
});

await scrollLatestReviewIntoView(page);
await page.waitForTimeout(360);
await moveCursor(page, 1215, 735, 220);
await smoothScrollAt(page, 1215, 735, 620, 560);
await page.waitForTimeout(140);
await smoothScrollAt(page, 1215, 735, 760, 620);
await page.waitForTimeout(140);
await smoothScrollAt(page, 1215, 735, 820, 620);
await page.waitForTimeout(240);

await moveCursor(page, 1920, 24, 320);
await page.getByLabel("Toggle CAD view").click();
await page.getByText("Drag to rotate, scroll to zoom").waitFor({ timeout: 20_000 });
await page.waitForTimeout(600);
await moveCursor(page, 2360, 720, 120);
await page.mouse.down();
await page.mouse.move(1700, 700, { steps: 18 });
await page.mouse.move(1120, 720, { steps: 16 });
await page.mouse.up();
await page.waitForTimeout(90);
await moveCursor(page, 2360, 740, 80);
await page.mouse.down();
await page.mouse.move(1660, 680, { steps: 18 });
await page.mouse.move(1040, 760, { steps: 16 });
await page.mouse.up();
await page.waitForTimeout(90);
await moveCursor(page, 2360, 700, 80);
await page.mouse.down();
await page.mouse.move(1580, 740, { steps: 18 });
await page.mouse.move(980, 700, { steps: 16 });
await page.mouse.up();
await page.waitForTimeout(420);
await moveCursor(page, 1885, 24, 220);
await page.getByLabel("Zoom CAD view to fit").click();
await page.waitForTimeout(1100);

await context.close();
await browser.close();

const webm = (await fs.readdir(rawDir)).find((file) => file.endsWith(".webm"));
if (!webm) throw new Error("Playwright did not produce a webm recording.");
run(ffmpegPath, [
  "-y",
  "-i",
  path.join(rawDir, webm),
  "-vf",
  `fps=${FPS}`,
  "-r",
  String(FPS),
  raw60Mp4,
]);
run(ffmpegPath, [
  "-y",
  "-i",
  raw60Mp4,
  "-vf",
  `fps=${FPS}`,
  path.join(extractedDir, "frame-%05d.png"),
]);

console.log(`saved frames in ${extractedDir}`);

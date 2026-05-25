import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const { default: sharp } = await import(
  pathToFileURL(
    path.join(repoRoot, "node_modules/.bun/sharp@0.34.5/node_modules/sharp/lib/index.js"),
  ).href
);
const { default: ffmpegPath } = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "node_modules/.bun/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/index.js",
    ),
  ).href
);

const workDir = path.join(__dirname, "out-real");
const extractedDir = path.join(workDir, "extracted");
const processedDir = path.join(workDir, "processed-final");
const processedMp4 = path.join(repoRoot, "product-demo.mp4");
const FPS = 60;
const START_SEC = 5.0;
const DURATION_SEC = 20.0;
const SRC_W = 2560;
const SRC_H = 1440;
const OUT_W = 1920;
const OUT_H = 1080;

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ease(t) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cameraAt(sec) {
  const keys = [
    [0.0, 1.0, 1280, 720],
    [0.7, 1.0, 1280, 720],
    [1.2, 1.16, 1265, 705],
    [5.6, 1.16, 1265, 705],
    [6.15, 1.0, 1280, 720],
    [9.2, 1.0, 1280, 720],
    [10.05, 2.15, 2190, 735],
    [16.1, 2.15, 2190, 735],
    [17.15, 1.0, 1280, 720],
    [DURATION_SEC, 1.0, 1280, 720],
  ];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (sec >= a[0] && sec <= b[0]) {
      const t = ease((sec - a[0]) / (b[0] - a[0]));
      return {
        zoom: a[1] + (b[1] - a[1]) * t,
        cx: a[2] + (b[2] - a[2]) * t,
        cy: a[3] + (b[3] - a[3]) * t,
      };
    }
  }
  return { zoom: 1, cx: 1280, cy: 720 };
}

function sourceSecAt(sec) {
  const keys = [
    [0.0, 5.0],
    [6.15, 10.1],
    [9.2, 13.7],
    [10.1, 15.0],
    [11.0, 17.0],
    [15.3, 34.0],
    [DURATION_SEC, 35.6],
  ];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (sec >= a[0] && sec <= b[0]) {
      const t = (sec - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return START_SEC + sec;
}

await fs.rm(processedDir, { recursive: true, force: true });
await fs.mkdir(processedDir, { recursive: true });

const frameCount = Math.round(DURATION_SEC * FPS);
for (let i = 0; i < frameCount; i++) {
  const sourceFrameNumber = Math.round(sourceSecAt(i / FPS) * FPS) + 1;
  const sourceFrame = path.join(
    extractedDir,
    `frame-${String(sourceFrameNumber).padStart(5, "0")}.png`,
  );
  const outputFrame = path.join(processedDir, `frame-${String(i + 1).padStart(5, "0")}.png`);
  const cam = cameraAt(i / FPS);
  const cropW = Math.round(SRC_W / cam.zoom);
  const cropH = Math.round(SRC_H / cam.zoom);
  const left = Math.max(0, Math.min(SRC_W - cropW, Math.round(cam.cx - cropW / 2)));
  const top = Math.max(0, Math.min(SRC_H - cropH, Math.round(cam.cy - cropH / 2)));
  await sharp(sourceFrame)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(OUT_W, OUT_H, { kernel: "lanczos3" })
    .png()
    .toFile(outputFrame);
}

run(ffmpegPath, [
  "-y",
  "-framerate",
  String(FPS),
  "-i",
  path.join(processedDir, "frame-%05d.png"),
  "-vf",
  "format=yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "16",
  "-movflags",
  "+faststart",
  "-r",
  String(FPS),
  processedMp4,
]);

console.log(`saved ${processedMp4}`);

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { defaultE2eDataDir, prepareE2eDataDir } from "./tests/helpers/e2e-data-dir";

/**
 * Browser acceptance for the offline fixture story.
 * The web server runs in fixture mode with an isolated DATA_DIR; no .env values,
 * network access or credentials are required.
 */
const port = Number(process.env.CC_E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const channel = process.env.PW_CHANNEL; // e.g. "chrome" to use a system Chrome

// Each run starts from an empty fixture database so the story is reproducible. The directory is
// checked before anything is deleted (see tests/helpers/e2e-data-dir.ts): a custom
// CC_E2E_DATA_DIR must be a directory the suite owns. The config is re-evaluated inside worker
// processes too, so only the main process prepares the directory.
const repoRoot = import.meta.dirname;
const dataDir = process.env.TEST_WORKER_INDEX
  ? path.resolve(process.env.CC_E2E_DATA_DIR?.trim() || defaultE2eDataDir(repoRoot))
  : prepareE2eDataDir(process.env.CC_E2E_DATA_DIR, {
      repoRoot,
      keep: Boolean(process.env.CC_E2E_KEEP_DATA),
    });

// The main-path spec starts from a case nobody has touched, so it gets its own server and its
// own data folder inside the suite's directory; the other specs share the first one in order.
const mainPathPort = port + 1;
const mainPathURL = `http://127.0.0.1:${mainPathPort}`;
const MAIN_PATH_SPEC = /main-path\.spec\.ts$/;

const server = (serverPort: number, serverDataDir: string) => ({
  command: `pnpm exec tsx scripts/demo.ts --port ${serverPort} --no-open`,
  url: `http://127.0.0.1:${serverPort}/api/health`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    APP_MODE: "fixture",
    DATA_DIR: serverDataDir,
    APP_ORIGIN: `http://127.0.0.1:${serverPort}`,
    NEXT_TELEMETRY_DISABLED: "1",
    CC_E2E: "1",
    // Serve the production build (pnpm build runs first via `pnpm test:e2e`) for stable timings.
    CC_DEMO_PROD: process.env.CC_E2E_DEV ? "" : "1",
  },
});

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results/e2e-output",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: "desktop",
      testIgnore: MAIN_PATH_SPEC,
      use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) },
    },
    {
      name: "main-path",
      testMatch: MAIN_PATH_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        ...(channel ? { channel } : {}),
        baseURL: mainPathURL,
      },
      metadata: { dataDir: path.join(dataDir, "main-path") },
    },
  ],
  webServer: [server(port, dataDir), server(mainPathPort, path.join(dataDir, "main-path"))],
});

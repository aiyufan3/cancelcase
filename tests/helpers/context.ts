import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppContext, type AppContext } from "@/server/context";
import { loadAppConfig } from "@/server/config";
import { FixtureAdapter } from "@/paypal/fixture-adapter";
import { readDemoHints, seedFixture } from "@/server/services/fixture-seed";
import { recordCancellation } from "@/server/services/case-service";
import type { Clock } from "@/domain/time";
import type { Drafter } from "@/llm/drafter";

export interface TestHarness {
  ctx: AppContext;
  caseId: string;
  clock: Clock & { advanceMinutes(n: number): void; set(iso: string): void };
  adapter: FixtureAdapter;
  cleanup(): void;
}

export function mutableClock(startIso: string): TestHarness["clock"] {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceMinutes(n: number) {
      current += n * 60_000;
    },
    set(iso: string) {
      current = new Date(iso).getTime();
    },
  };
}

export function createTestHarness(
  options: {
    clockIso?: string;
    drafter?: Drafter;
    onDisk?: boolean;
    confirmCancellation?: boolean;
  } = {},
): TestHarness {
  const clock = mutableClock(options.clockIso ?? "2026-11-09T09:00:00Z");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cancelcase-test-"));
  const config = loadAppConfig({
    APP_MODE: "fixture",
    DATA_DIR: tmp,
    APP_ORIGIN: "http://127.0.0.1:3999",
    DEMO_RECORDING_MODE: "true",
  } as unknown as NodeJS.ProcessEnv);
  const adapter = new FixtureAdapter(path.join(tmp, "provider-simulation.json"), clock);
  const ctx = createAppContext({
    config,
    clock,
    adapter,
    inMemory: !options.onDisk,
    drafter: options.drafter,
  });
  const seed = seedFixture(ctx);
  if (options.confirmCancellation !== false) {
    const hints = readDemoHints(ctx)!;
    recordCancellation(ctx, {
      caseId: seed.caseId,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: hints.confirmation.receivedAt,
        effectiveAt: hints.confirmation.effectiveAt,
        basis: hints.confirmation.basis,
        evidenceIds: hints.confirmation.evidenceIds,
      },
    });
  }
  return {
    ctx,
    caseId: seed.caseId,
    clock,
    adapter,
    cleanup() {
      try {
        ctx.db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

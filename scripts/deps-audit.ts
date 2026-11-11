#!/usr/bin/env tsx
/**
 * pnpm deps:audit — production dependency audit with an explicit residual-risk list.
 *
 * Fails when:
 *   - the registry audit is unavailable, interrupted, or returns an invalid report,
 *   - an advisory is not in scripts/accepted-advisories.json,
 *   - an accepted advisory appears on a dependency path it was not reviewed for,
 *   - the review date of the accepted list has passed.
 * Accepted advisories that no longer appear are reported so the list can shrink.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface Accepted {
  id: string;
  module: string;
  via: string;
  reason: string;
}

interface Finding {
  paths: string[];
  version: string;
}

interface Advisory {
  github_advisory_id: string;
  module_name: string;
  severity: string;
  title: string;
  findings: Finding[];
}

const listFile = path.resolve(import.meta.dirname, "accepted-advisories.json");
const list = JSON.parse(fs.readFileSync(listFile, "utf8")) as {
  reviewBy: string;
  accepted: Accepted[];
};

const run = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8" });
function invalidReport(): never {
  console.error("deps:audit: no valid completed audit report; check registry access and retry.");
  process.exit(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAdvisory(value: unknown): value is Advisory {
  return (
    isRecord(value) &&
    ["github_advisory_id", "module_name", "severity", "title"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    Array.isArray(value.findings) &&
    value.findings.length > 0 &&
    value.findings.every(
      (finding: unknown) =>
        isRecord(finding) &&
        typeof finding.version === "string" &&
        finding.version.length > 0 &&
        Array.isArray(finding.paths) &&
        finding.paths.length > 0 &&
        finding.paths.every((p: unknown) => typeof p === "string" && p.length > 0),
    )
  );
}

if (run.error || run.signal || (run.status !== 0 && run.status !== 1)) invalidReport();
let raw: unknown;
try {
  raw = JSON.parse(run.stdout);
} catch {
  invalidReport();
}
if (!isRecord(raw) || "error" in raw || !isRecord(raw.advisories)) invalidReport();
const advisories = Object.values(raw.advisories);
if (!advisories.every(isAdvisory) || (run.status === 1 && advisories.length === 0)) invalidReport();

const problems: string[] = [];
const seen = new Set<string>();
for (const adv of advisories) {
  const accepted = list.accepted.find(
    (a) => a.id === adv.github_advisory_id && a.module === adv.module_name,
  );
  const paths = adv.findings.flatMap((f) => f.paths);
  if (!accepted) {
    problems.push(
      `${adv.severity} ${adv.module_name} ${adv.github_advisory_id}: ${adv.title} (via ${paths.slice(0, 2).join(", ")})`,
    );
    continue;
  }
  seen.add(accepted.id);
  const prefix = `.>${accepted.via}>`;
  const outside = paths.filter((p) => !p.startsWith(prefix));
  if (outside.length > 0)
    problems.push(
      `${adv.module_name} ${adv.github_advisory_id} is accepted only via ${accepted.via}, but also appears via ${outside.slice(0, 2).join(", ")}`,
    );
}

const today = new Date().toISOString().slice(0, 10);
if (today > list.reviewBy)
  problems.push(`the accepted advisory list was due for review on ${list.reviewBy}`);

const gone = list.accepted.filter((a) => !seen.has(a.id));
console.log(
  `deps:audit: ${advisories.length} production advisories; ${seen.size} accepted as residual risk (review by ${list.reviewBy}).`,
);
for (const a of gone)
  console.log(`  no longer reported: ${a.module} ${a.id} — remove it from the accepted list.`);
if (problems.length > 0) {
  console.error("deps:audit: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("deps:audit: OK");

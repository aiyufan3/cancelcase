#!/usr/bin/env tsx
/**
 * pnpm security:staged
 *
 * Fails closed when anything private or secret-looking is staged:
 *   1. private-path check: ignored-by-policy paths must never be staged
 *   2. content check: machine paths and references to private workspace material must not
 *      appear in public files
 *   3. secret scan: the pinned `secretlint` scanner runs on the exact staged blobs, masked output
 *   4. optional extra: `gitleaks` on the staged diff when the pinned binary is on PATH
 *
 * Nothing here prints secret values. Exit code 0 only when every check passes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const GITLEAKS_PINNED = "8.21.2";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const PRIVATE_PATH_RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /^\.env(?!\.example$)(\..*)?$/, why: "environment file" },
  { pattern: /^[^/]+-kit(\/|$)/, why: "private workspace kit" },
  { pattern: /(^|\/)\.private(\/|$)/, why: "private notes" },
  { pattern: /(^|\/)private(\/|$)/, why: "private directory" },
  { pattern: /(^|\/)notes(\/|$)/, why: "notes directory" },
  { pattern: /(^|\/)\.claude(\/|$)/, why: "assistant settings" },
  {
    pattern:
      /(^|\/)\.cursor(\/|$)|\.cursorrules$|(^|\/)\.aider|(^|\/)\.codex(\/|$)|(^|\/)\.windsurf(\/|$)|(^|\/)\.continue(\/|$)/,
    why: "assistant tooling",
  },
  { pattern: /(^|\/)PROMPT[^/]*\.md$/, why: "prompt file" },
  { pattern: /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS|agent)\.md$/, why: "assistant instruction file" },
  {
    pattern: /(^|\/)handoff[^/]*\.md$|(^|\/)research-plan[^/]*\.md$/,
    why: "working notes",
  },
  { pattern: /\.(private|local)\.md$/, why: "private markdown" },
  { pattern: /\.(sqlite|sqlite3|db)(-[a-z]+)?$/, why: "database file" },
  {
    pattern: /^data(\/|$)|(^|\/)uploads(\/|$)|(^|\/)recordings(\/|$)|(^|\/)evidence\/local(\/|$)/,
    why: "runtime data",
  },
  { pattern: /\.(log|har)$|(^|\/)logs(\/|$)/, why: "logs or network captures" },
  {
    pattern:
      /\.(pem|key|p12|pfx|ppk)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|(^|\/)allowed_signers$|(^|\/)\.ssh(\/|$)/,
    why: "key material",
  },
  { pattern: /(^|\/)secrets(\/|$)|(^|\/)credentials[^/]*\.json$/, why: "credentials" },
  {
    pattern: /(^|\/)(storage-state|auth-state)[^/]*\.json$|(^|\/)playwright\/\.auth(\/|$)/,
    why: "browser authentication state",
  },
  {
    pattern: /^(test-results|playwright-report|coverage|\.next|node_modules|dist|build|out)(\/|$)/,
    why: "build or test output",
  },
];

const CONTENT_RULES: { pattern: RegExp; why: string; allowIn?: RegExp }[] = [
  {
    // A path into a top-level "*-kit/" directory or into ".private/": both are local-only.
    pattern: /(^|[^A-Za-z0-9@_-])[a-z0-9]+(?:-[a-z0-9]+)*-kit\/|(^|[^A-Za-z0-9_-])\.private\//,
    why: "reference to private workspace material",
    allowIn: /^(\.gitignore|scripts\/security-staged\.ts)$/,
  },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, why: "macOS home path" },
  { pattern: /\/home\/[A-Za-z0-9._-]+\//, why: "Linux home path" },
  { pattern: /C:\\Users\\/, why: "Windows home path" },
  { pattern: /PayPal-Auth-Assertion:\s*ey[A-Za-z0-9_-]{10,}/, why: "auth assertion value" },
  { pattern: /\bA21AA[A-Za-z0-9_-]{20,}/, why: "PayPal access token shape" },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, why: "model API key shape" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "private key block" },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    why: "GitHub token shape",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key shape" },
  { pattern: /\b[AE][A-Za-z0-9_-]{79}\b/, why: "PayPal client credential shape (80 characters)" },
  {
    pattern:
      /(?:api[_-]?key|client[_-]?secret|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{24,}["']/i,
    why: "credential assignment with a literal value",
    allowIn: /^tests\//,
  },
];

const scanAll = process.argv.includes("--all");

/** Staged files by default; with --all every tracked file (used by CI on a clean checkout). */
function stagedFiles(): string[] {
  const args = scanAll
    ? ["ls-files", "-z"]
    : ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"];
  const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function fileBytes(file: string): Buffer {
  return scanAll
    ? fs.readFileSync(file)
    : execFileSync("git", ["show", `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

interface Finding {
  check: string;
  file: string;
  message: string;
}

function main(): number {
  let files: string[];
  try {
    files = stagedFiles();
  } catch (err) {
    console.error(
      "security:staged: not a git repository or git unavailable.",
      err instanceof Error ? err.message : err,
    );
    return 2;
  }
  const findings: Finding[] = [];
  if (files.length === 0) {
    console.log(
      scanAll ? "security:staged: no tracked files." : "security:staged: nothing staged.",
    );
  }

  for (const file of files) {
    for (const rule of PRIVATE_PATH_RULES) {
      if (rule.pattern.test(file))
        findings.push({
          check: "private-path",
          file,
          message: `${rule.why} must not be committed`,
        });
    }
  }
  // Ignored paths that are nevertheless staged (force-added) are rejected too.
  for (const file of files) {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { encoding: "utf8" });
    if (r.status === 0)
      findings.push({
        check: "private-path",
        file,
        message: "path matches .gitignore but is staged (force-add refused)",
      });
  }

  // Materialize staged blobs for content checks and the scanner.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-staged-"));
  try {
    for (const file of files) {
      const blob = fileBytes(file);
      const target = path.join(tmp, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, blob);
      if (isBinary(blob)) continue;
      const text = blob.toString("utf8");
      for (const rule of CONTENT_RULES) {
        if (rule.allowIn?.test(file)) continue;
        if (rule.pattern.test(text)) findings.push({ check: "content", file, message: rule.why });
      }
    }

    if (files.length > 0) {
      const secretlintBin = resolveBin("secretlint");
      if (!secretlintBin) {
        findings.push({
          check: "scanner",
          file: "(all)",
          message:
            "secretlint is not installed; refusing to commit without the pinned scanner (run pnpm install)",
        });
      } else {
        const rc = path.resolve(".secretlintrc.json");
        const r = spawnSync(
          process.execPath,
          [secretlintBin, "--secretlintrc", rc, "--maskSecrets", "--format", "json", `${tmp}/**/*`],
          {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (r.status !== 0 && r.status !== 1) {
          findings.push({
            check: "scanner",
            file: "(all)",
            message: `secretlint failed to run (exit ${r.status}): ${(r.stderr || "").slice(0, 300)}`,
          });
        } else {
          try {
            const report = JSON.parse(r.stdout || "[]") as {
              filePath: string;
              messages: { message: string; ruleId: string; loc?: { start?: { line?: number } } }[];
            }[];
            for (const entry of report) {
              for (const m of entry.messages) {
                findings.push({
                  check: "secretlint",
                  file: path.relative(tmp, entry.filePath),
                  message: `${m.ruleId}: ${m.message}${m.loc?.start?.line ? ` (line ${m.loc.start.line})` : ""}`,
                });
              }
            }
          } catch {
            if (r.status === 1)
              findings.push({
                check: "secretlint",
                file: "(all)",
                message: "secretlint reported findings (unparseable output)",
              });
          }
        }
      }

      const gitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
      if (gitleaks.status === 0) {
        const version = gitleaks.stdout.trim();
        const diff = scanAll
          ? execFileSync("git", ["diff", "--no-ext-diff", "--binary", EMPTY_TREE, "HEAD"], {
              maxBuffer: 256 * 1024 * 1024,
            })
          : execFileSync("git", ["diff", "--cached", "--no-ext-diff", "--binary"], {
              maxBuffer: 64 * 1024 * 1024,
            });
        const g = spawnSync("gitleaks", ["stdin", "--redact", "--no-banner", "--exit-code", "1"], {
          input: diff,
          encoding: "utf8",
        });
        if (g.status === 1)
          findings.push({
            check: "gitleaks",
            file: "(diff)",
            message: `gitleaks ${version} reported leaks:\n${(g.stdout || g.stderr || "").slice(0, 2000)}`,
          });
        else if (g.status !== 0)
          findings.push({
            check: "gitleaks",
            file: "(diff)",
            message: `gitleaks failed to run (exit ${g.status})`,
          });
        else
          console.log(
            `security:staged: gitleaks ${version} found nothing (extra check; pinned reference ${GITLEAKS_PINNED}).`,
          );
      } else {
        console.log(
          "security:staged: gitleaks not on PATH; skipped as an optional extra (secretlint is the required scanner).",
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (findings.length > 0) {
    console.error(`security:staged: ${findings.length} finding(s)\n`);
    for (const f of findings) console.error(`  [${f.check}] ${f.file}: ${f.message}`);
    console.error(
      "\nUnstage or fix the files above. Private material must stay out of the repository.",
    );
    return 1;
  }
  console.log(
    `security:staged: OK (${files.length} ${scanAll ? "tracked" : "staged"} file(s) checked: private paths, content rules, secretlint).`,
  );
  return 0;
}

function resolveBin(name: string): string | null {
  try {
    const pkgDir = path.dirname(require.resolve(`${name}/package.json`));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
    return bin ? path.join(pkgDir, bin) : null;
  } catch {
    return null;
  }
}

process.exit(main());

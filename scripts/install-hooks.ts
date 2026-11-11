#!/usr/bin/env tsx
/**
 * pnpm hooks:install (also run by `pnpm install` through the prepare script)
 *
 * Installs a pre-commit hook that runs `pnpm security:staged`. It never overwrites a hook it
 * did not write: an existing foreign hook is left alone and chaining instructions are printed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MARKER = "# cancelcase-pre-commit v1";
const quiet = process.argv.includes("--quiet");
const log = (msg: string) => {
  if (!quiet) console.log(msg);
};

function main(): number {
  let gitDir: string;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    log("hooks:install: not a git repository; nothing to do.");
    return 0;
  }
  try {
    const configured = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (configured) {
      console.log(
        `hooks:install: core.hooksPath is set to ${configured}; add \`pnpm security:staged\` to that pre-commit hook yourself.`,
      );
      return 0;
    }
  } catch {
    /* unset */
  }
  const hooksPath = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksPath, { recursive: true });
  const target = path.join(hooksPath, "pre-commit");
  const script = `#!/bin/sh
${MARKER}
# Runs the staged-content security check before every commit. Fails closed.
if command -v pnpm >/dev/null 2>&1; then
  pnpm --silent security:staged || exit 1
else
  echo "pre-commit: pnpm is not on PATH; refusing to commit without the security check." >&2
  exit 1
fi
`;
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (!existing.includes(MARKER)) {
      console.log(
        `hooks:install: an existing pre-commit hook was found at ${target} and was left untouched.`,
      );
      console.log(
        "Add this line to it to keep the staged security check: pnpm --silent security:staged || exit 1",
      );
      return 0;
    }
    if (existing === script) {
      log("hooks:install: pre-commit hook already installed.");
      return 0;
    }
  }
  fs.writeFileSync(target, script, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  log(`hooks:install: pre-commit hook installed at ${target}.`);
  return 0;
}

process.exit(main());

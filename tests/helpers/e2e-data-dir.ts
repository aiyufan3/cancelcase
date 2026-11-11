import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The browser suite starts from an empty data directory, so it deletes one recursively before
 * each run. That delete must never reach anything but a directory the suite owns: not the
 * repository, not the local Sandbox data, not a home folder, not the target of a link.
 *
 * A directory may be emptied only when all of this holds:
 *   - it is not a symbolic link, and its real path (links in parent folders resolved) lies
 *     strictly inside an allowed root: the repository's own `test-results/` or the system
 *     temporary folder;
 *   - it is the suite's fixed default location, or it does not exist yet, or it is empty, or it
 *     carries the marker file this helper wrote when it created the directory.
 * Anything else stops the run with an explanation and deletes nothing.
 *
 * The allowed roots are anchored on places that are trusted as given: the repository root and
 * the system temporary folder. Only those anchors are resolved. `test-results` is then added
 * by name, never by following it, so a `test-results` that is itself a link leads outside the
 * root instead of moving the root to wherever the link points. For the same reason the default
 * location counts as the suite's own only when its real path is the one inside the real
 * repository; reaching another folder through the default path earns no exemption.
 */
export const E2E_DIR_MARKER = ".cancelcase-e2e-data";

export interface E2eDataDirOptions {
  repoRoot: string;
  /** Keep the existing content (CC_E2E_KEEP_DATA). The location is still checked. */
  keep?: boolean;
  /**
   * Trusted temporary folders a custom directory may live under, besides the repository's own
   * test-results/. Defaults to the system temporary folders. Tests pass a stand-in.
   */
  tempRoots?: string[];
}

function realpathAllowingMissing(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

function strictlyInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function defaultE2eDataDir(repoRoot: string): string {
  return path.resolve(repoRoot, "test-results", "e2e-data");
}

function refuse(dir: string, why: string): never {
  throw new Error(
    `CC_E2E_DATA_DIR: refusing to use ${dir} as the browser suite's data directory: ${why}. ` +
      "Nothing was deleted. Use a new empty directory under the system temporary folder, or leave the variable unset.",
  );
}

/** Check the directory and, unless `keep` is set, empty it. Returns the resolved path. */
export function prepareE2eDataDir(
  requested: string | undefined,
  options: E2eDataDirOptions,
): string {
  const fallback = defaultE2eDataDir(options.repoRoot);
  const dir = path.resolve(requested && requested.trim() ? requested : fallback);
  // Trusted anchors, resolved; `test-results` is appended by name and not resolved.
  const repoResults = path.join(fs.realpathSync(options.repoRoot), "test-results");
  const tempRoots = (
    options.tempRoots ?? [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
  )
    .filter((r) => fs.existsSync(r))
    .map((r) => fs.realpathSync(r));
  const roots = [repoResults, ...tempRoots];

  const stat = fs.lstatSync(dir, { throwIfNoEntry: false }) ?? null;
  if (stat?.isSymbolicLink()) refuse(dir, "it is a symbolic link");
  if (stat && !stat.isDirectory()) refuse(dir, "it is not a directory");
  const real = realpathAllowingMissing(dir);
  if (!roots.some((root) => strictlyInside(real, root)))
    refuse(
      dir,
      "it does not lie inside the repository's test-results folder or the system temporary folder",
    );
  // The suite's own fixed location, by where it really is, not by how the path is spelled.
  const ownDefault = real === path.join(repoResults, "e2e-data");
  if (stat && !ownDefault) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0 && !entries.includes(E2E_DIR_MARKER))
      refuse(dir, "it already holds files this suite did not create");
  }
  if (options.keep) {
    if (!stat) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, E2E_DIR_MARKER), "");
    }
    return dir;
  }
  if (stat) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, E2E_DIR_MARKER), "");
  return dir;
}

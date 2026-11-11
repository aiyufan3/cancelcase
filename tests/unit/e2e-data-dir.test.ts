import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2E_DIR_MARKER, defaultE2eDataDir, prepareE2eDataDir } from "../helpers/e2e-data-dir";

/**
 * The browser suite deletes its data directory recursively (audit T07). Every dangerous path
 * here is a stand-in built inside one temporary folder: a pretend repository, a pretend home
 * and a pretend Sandbox data folder. No real directory is ever passed to the helper.
 */
let sandbox: string;
let repoRoot: string;
let allowed: string;
let home: string;
let options: { repoRoot: string; tempRoots: string[] };

function fill(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "keep-me.txt");
  fs.writeFileSync(file, "must survive");
  return file;
}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-dir-")));
  repoRoot = path.join(sandbox, "repo");
  allowed = path.join(sandbox, "tmp");
  home = path.join(sandbox, "home", "someone");
  fs.mkdirSync(path.join(repoRoot, "test-results"), { recursive: true });
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  options = { repoRoot, tempRoots: [allowed] };
});
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe("browser suite data directory", () => {
  it("empties the fixed default location and a marked or new custom directory", () => {
    const fallback = defaultE2eDataDir(repoRoot);
    const old = fill(fallback);
    expect(prepareE2eDataDir(undefined, options)).toBe(fallback);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readdirSync(fallback)).toEqual([E2E_DIR_MARKER]);

    const custom = path.join(allowed, "run-1");
    expect(prepareE2eDataDir(custom, options)).toBe(custom);
    expect(fs.readdirSync(custom)).toEqual([E2E_DIR_MARKER]);
    const leftover = fill(path.join(custom, "fixture"));
    prepareE2eDataDir(custom, options);
    expect(fs.existsSync(leftover)).toBe(false);

    // An empty directory someone made beforehand is fine too.
    const empty = path.join(allowed, "empty");
    fs.mkdirSync(empty);
    prepareE2eDataDir(empty, options);
    expect(fs.readdirSync(empty)).toEqual([E2E_DIR_MARKER]);
  });

  it("refuses the repository, its data folders, a home folder and the allowed roots themselves", () => {
    const sandboxData = path.join(repoRoot, "data", "local", "sandbox");
    const survivors = [
      fill(repoRoot),
      fill(sandboxData),
      fill(path.join(repoRoot, "src")),
      fill(home),
      fill(path.join(home, "Documents")),
      fill(allowed),
    ];
    for (const dir of [
      repoRoot,
      path.join(repoRoot, "data"),
      sandboxData,
      path.join(repoRoot, "src"),
      path.join(repoRoot, "test-results"),
      path.join(repoRoot, "test-results", "..", "data", "local", "sandbox"),
      home,
      path.join(home, "Documents"),
      path.dirname(home),
      sandbox,
      allowed,
    ]) {
      expect(() => prepareE2eDataDir(dir, options), dir).toThrow(/refusing to use/);
    }
    for (const file of survivors) expect(fs.readFileSync(file, "utf8")).toBe("must survive");
  });

  it("refuses a directory that holds files the suite did not create", () => {
    const foreign = path.join(allowed, "someones-work");
    const file = fill(foreign);
    expect(() => prepareE2eDataDir(foreign, options)).toThrow(/did not create/);
    expect(() => prepareE2eDataDir(foreign, { ...options, keep: true })).toThrow(/did not create/);
    expect(fs.readFileSync(file, "utf8")).toBe("must survive");

    const notADir = path.join(allowed, "a-file");
    fs.writeFileSync(notADir, "x");
    expect(() => prepareE2eDataDir(notADir, options)).toThrow(/not a directory/);
    expect(fs.readFileSync(notADir, "utf8")).toBe("x");
  });

  it("refuses links: the directory itself, and a parent folder that leads elsewhere", () => {
    const target = path.join(home, "Documents");
    const file = fill(target);
    fs.writeFileSync(path.join(target, E2E_DIR_MARKER), "");

    const link = path.join(allowed, "linked");
    fs.symlinkSync(target, link);
    expect(() => prepareE2eDataDir(link, options)).toThrow(/symbolic link/);

    const parentLink = path.join(allowed, "via");
    fs.symlinkSync(home, parentLink);
    expect(() => prepareE2eDataDir(path.join(parentLink, "Documents"), options)).toThrow(
      /does not lie inside/,
    );
    expect(() => prepareE2eDataDir(path.join(parentLink, "new-dir"), options)).toThrow(
      /does not lie inside/,
    );
    expect(fs.existsSync(path.join(home, "new-dir"))).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("must survive");

    // Even the default location is refused when it has been replaced by a link.
    const fallback = defaultE2eDataDir(repoRoot);
    fs.symlinkSync(target, fallback);
    expect(() => prepareE2eDataDir(undefined, options)).toThrow(/symbolic link/);
    expect(fs.readFileSync(file, "utf8")).toBe("must survive");
  });

  it("keeps existing content when asked to, after the same checks", () => {
    const custom = path.join(allowed, "kept");
    prepareE2eDataDir(custom, options);
    const data = fill(path.join(custom, "fixture"));
    expect(prepareE2eDataDir(custom, { ...options, keep: true })).toBe(custom);
    expect(fs.readFileSync(data, "utf8")).toBe("must survive");
    expect(() => prepareE2eDataDir(home, { ...options, keep: true })).toThrow(/refusing to use/);
  });
  it("does not follow a linked test-results folder, with or without the default path", () => {
    // The repository's own test-results folder replaced by a link to someone else's work.
    const foreign = path.join(sandbox, "foreign-work");
    const kept = fill(path.join(foreign, "e2e-data"));
    fs.rmSync(path.join(repoRoot, "test-results"), { recursive: true });
    fs.symlinkSync(foreign, path.join(repoRoot, "test-results"));

    // The default path, with the roots the real configuration uses. Here the link's target
    // happens to sit inside the system temporary folder, as every stand-in in this test does.
    expect(() => prepareE2eDataDir(undefined, { repoRoot })).toThrow(/refusing to use/);
    expect(fs.readFileSync(kept, "utf8")).toBe("must survive");
    expect(() => prepareE2eDataDir(undefined, { repoRoot, keep: true })).toThrow(/refusing to use/);

    // The same with the target outside every allowed root.
    expect(() => prepareE2eDataDir(undefined, options)).toThrow(/does not lie inside/);
    expect(() =>
      prepareE2eDataDir(path.join(repoRoot, "test-results", "e2e-data"), options),
    ).toThrow(/does not lie inside/);
    expect(() =>
      prepareE2eDataDir(path.join(repoRoot, "test-results", "another"), options),
    ).toThrow(/does not lie inside/);
    expect(fs.existsSync(path.join(foreign, "another"))).toBe(false);

    // A marker inside the foreign folder does not make it the suite's own default location.
    fs.writeFileSync(path.join(foreign, "e2e-data", E2E_DIR_MARKER), "");
    expect(() => prepareE2eDataDir(undefined, options)).toThrow(/does not lie inside/);
    expect(fs.readFileSync(kept, "utf8")).toBe("must survive");
    expect(fs.readdirSync(foreign)).toEqual(["e2e-data"]);
  });

  it("does not follow a link further up inside test-results either", () => {
    const foreign = path.join(sandbox, "foreign-work");
    const kept = fill(path.join(foreign, "run"));
    fs.symlinkSync(foreign, path.join(repoRoot, "test-results", "linked"));
    expect(() =>
      prepareE2eDataDir(path.join(repoRoot, "test-results", "linked", "run"), options),
    ).toThrow(/does not lie inside/);
    expect(fs.readFileSync(kept, "utf8")).toBe("must survive");
  });
});

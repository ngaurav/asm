import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateLibraryBundle,
  deactivateLibraryBundle,
  findLibraryEntryForBundleSkill,
  installBundleToLibrary,
  parseBundleInstallUrl,
} from "./library-bundles";
import { writeLibraryLock } from "./library";
import type { BundleManifest, LibraryLockFile } from "./utils/types";

function bundle(): BundleManifest {
  return {
    version: 1,
    name: "owner-repo",
    description: "Bundle",
    author: "tester",
    createdAt: "2026-06-22T00:00:00.000Z",
    skills: [
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      { name: "skill-b", installUrl: "github:owner/repo:skills/skill-b" },
    ],
  };
}

describe("parseBundleInstallUrl", () => {
  it("splits GitHub repo source and skill path", () => {
    expect(
      parseBundleInstallUrl({
        name: "skill-a",
        installUrl: "github:owner/repo:skills/skill-a",
      }),
    ).toEqual({
      source: "github:owner/repo",
      sourceType: "github",
      skillPath: "skills/skill-a",
    });
  });
});

describe("findLibraryEntryForBundleSkill", () => {
  const lock: LibraryLockFile = {
    version: 1,
    skills: {
      aliased: {
        name: "different-frontmatter",
        version: "1.0.0",
        source: "github:owner/repo",
        sourceType: "github",
        commitHash: "abc",
        ref: "main",
        skillPath: "skills/skill-a",
        libraryPath: "/library/aliased",
        installedAt: "2026-06-22T00:00:00.000Z",
      },
      "skill-b": {
        name: "skill-b",
        version: "1.0.0",
        source: "github:someone/else",
        sourceType: "github",
        commitHash: "abc",
        ref: "main",
        skillPath: "skills/skill-b",
        libraryPath: "/library/skill-b",
        installedAt: "2026-06-22T00:00:00.000Z",
      },
    },
  };

  it("prefers source and skillPath over name", () => {
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      lock,
    );
    expect(match).toMatchObject({
      dirName: "aliased",
      entry: lock.skills.aliased,
    });
  });

  it("falls back to directory name", () => {
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-b", installUrl: "github:owner/repo:skills/missing" },
      lock,
    );
    expect(match).toMatchObject({
      dirName: "skill-b",
      entry: lock.skills["skill-b"],
    });
  });

  it("returns ambiguous matches at the same precedence", () => {
    const ambiguous: LibraryLockFile = {
      version: 1,
      skills: {
        one: lock.skills.aliased,
        two: { ...lock.skills.aliased, libraryPath: "/library/two" },
      },
    };
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      ambiguous,
    );
    expect(match).toEqual({ ambiguous: ["one", "two"] });
  });
});

describe("installBundleToLibrary", () => {
  it("continues after individual install failures and reports failed count", async () => {
    const summary = await installBundleToLibrary(bundle(), {
      force: false,
      installSkillFromRef: async (ref) => {
        if (ref.name === "skill-b") {
          throw new Error("install failed");
        }
        return { name: ref.name, libraryPath: `/library/${ref.name}` };
      },
    });

    expect(summary).toMatchObject({
      bundleName: "owner-repo",
      total: 2,
      installed: 1,
      failed: 1,
    });
    expect(summary.results).toEqual([
      {
        name: "skill-a",
        status: "installed",
        installed: true,
        libraryPath: "/library/skill-a",
      },
      { name: "skill-b", status: "failed", reason: "install failed" },
    ]);
  });
});

describe("library bundle activation", () => {
  let tempDir: string;
  let lockPath: string;
  let skillsDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asm-library-bundle-"));
    lockPath = join(tempDir, "library-lock.json");
    skillsDir = join(tempDir, "library", "skills");
    targetDir = join(tempDir, "provider", "skills");
    for (const name of ["skill-a", "skill-b"]) {
      const dir = join(skillsDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`,
      );
    }
    await writeLibraryLock(
      {
        version: 1,
        skills: {
          "skill-a": {
            name: "skill-a",
            version: "1.0.0",
            source: "github:owner/repo",
            sourceType: "github",
            commitHash: "abc",
            ref: "main",
            skillPath: "skills/skill-a",
            libraryPath: join(skillsDir, "skill-a"),
            installedAt: "2026-06-22T00:00:00.000Z",
          },
          "skill-b": {
            name: "skill-b",
            version: "1.0.0",
            source: "github:owner/repo",
            sourceType: "github",
            commitHash: "abc",
            ref: "main",
            skillPath: "skills/skill-b",
            libraryPath: join(skillsDir, "skill-b"),
            installedAt: "2026-06-22T00:00:00.000Z",
          },
        },
      },
      lockPath,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("activates all bundle skills from the library", async () => {
    const summary = await activateLibraryBundle(bundle(), {
      lockPath,
      targetDir,
      provider: "codex",
      scope: "project",
      force: false,
    });

    expect(summary).toMatchObject({
      bundleName: "owner-repo",
      total: 2,
      activated: 2,
      failed: 0,
    });
    await expect(readlink(join(targetDir, "skill-a"))).resolves.toBe(
      join(skillsDir, "skill-a"),
    );
    await expect(readlink(join(targetDir, "skill-b"))).resolves.toBe(
      join(skillsDir, "skill-b"),
    );
  });

  it("reports missing skills without installMissing", async () => {
    const partial = bundle();
    partial.skills.push({
      name: "missing",
      installUrl: "github:owner/repo:skills/missing",
    });

    const summary = await activateLibraryBundle(partial, {
      lockPath,
      targetDir,
      provider: "codex",
      scope: "project",
      force: false,
    });

    expect(summary.missing).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results.find((r) => r.name === "missing")).toMatchObject({
      status: "missing",
      reason:
        'Library skill "missing" is not installed. Use --install-missing.',
    });
  });

  it("deactivates all safe bundle symlinks and skips missing activations", async () => {
    await mkdir(targetDir, { recursive: true });
    await symlink(
      join(skillsDir, "skill-a"),
      join(targetDir, "skill-a"),
      "dir",
    );

    const summary = await deactivateLibraryBundle(bundle(), {
      targetDir,
      provider: "codex",
      scope: "project",
      librarySkillsDir: skillsDir,
    });

    expect(summary).toMatchObject({
      total: 2,
      deactivated: 1,
      skipped: 1,
      failed: 0,
    });
    await expect(lstat(join(targetDir, "skill-a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

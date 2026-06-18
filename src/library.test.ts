import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  emptyLibraryLock,
  activateLibrarySkill,
  installLibrarySkill,
  readLibraryLock,
  writeLibraryLock,
} from "./library";

describe("library lock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asm-library-test-"));
    lockPath = join(tempDir, "library-lock.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("readLibraryLock returns an empty lock when the file is missing", async () => {
    await expect(readLibraryLock(lockPath)).resolves.toEqual({
      version: 1,
      skills: {},
    });
  });

  test("writeLibraryLock persists a versioned lock file", async () => {
    const lock = emptyLibraryLock();
    lock.skills.brainstorming = {
      name: "brainstorming",
      version: "1.0.0",
      source: "github:obra/superpowers",
      sourceType: "github",
      commitHash: "abc123",
      ref: "main",
      skillPath: "skills/brainstorming",
      libraryPath: join(tempDir, "skills", "brainstorming"),
      installedAt: "2026-06-18T00:00:00.000Z",
    };

    await writeLibraryLock(lock, lockPath);

    await expect(readLibraryLock(lockPath)).resolves.toEqual(lock);
  });

  test("readLibraryLock rejects array skills and backs up the invalid lock", async () => {
    const invalidLock = JSON.stringify({ version: 1, skills: [] }, null, 2);
    await writeFile(lockPath, invalidLock, "utf-8");

    await expect(readLibraryLock(lockPath)).resolves.toEqual({
      version: 1,
      skills: {},
    });

    await expect(readFile(lockPath + ".bak", "utf-8")).resolves.toBe(
      invalidLock,
    );
  });
});

describe("installLibrarySkill", () => {
  let tempDir: string;
  let lockPath: string;
  let skillsDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asm-library-install-"));
    lockPath = join(tempDir, "library-lock.json");
    skillsDir = join(tempDir, "skills");
    sourceDir = join(tempDir, "source", "skills", "brainstorming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "SKILL.md"),
      "---\nname: brainstorming\nversion: 1.0.0\n---\n# Body\n",
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("copies a skill directory and writes source metadata", async () => {
    await writeFile(
      join(sourceDir, "SKILL.md"),
      "---\nname: brainstorming\nversion: 1.2.3\n---\n# Brainstorming\n",
    );

    const result = await installLibrarySkill(
      {
        sourceDir,
        libraryName: "brainstorming",
        source: "github:obra/superpowers",
        sourceType: "github",
        commitHash: "abc123",
        ref: "main",
        skillPath: "skills/brainstorming",
        force: false,
      },
      { skillsDir, lockPath },
    );

    expect(result.name).toBe("brainstorming");
    expect(result.version).toBe("1.2.3");
    expect(
      await readFile(join(result.libraryPath, "SKILL.md"), "utf-8"),
    ).toContain("Brainstorming");

    const lock = await readLibraryLock(lockPath);
    expect(lock.skills.brainstorming).toMatchObject({
      name: "brainstorming",
      version: "1.2.3",
      source: "github:obra/superpowers",
      sourceType: "github",
      commitHash: "abc123",
      ref: "main",
      skillPath: "skills/brainstorming",
      libraryPath: result.libraryPath,
    });
  });

  test("refuses to overwrite an existing library skill without force", async () => {
    await installLibrarySkill(
      {
        sourceDir,
        libraryName: "brainstorming",
        source: "local:/tmp/source",
        sourceType: "local",
        commitHash: "unknown",
        ref: null,
        skillPath: "skills/brainstorming",
        force: false,
      },
      { skillsDir, lockPath },
    );

    await expect(
      installLibrarySkill(
        {
          sourceDir,
          libraryName: "brainstorming",
          source: "local:/tmp/source",
          sourceType: "local",
          commitHash: "unknown",
          ref: null,
          skillPath: "skills/brainstorming",
          force: false,
        },
        { skillsDir, lockPath },
      ),
    ).rejects.toThrow(/already exists/);

    await expect(lstat(join(skillsDir, "brainstorming"))).resolves.toBeTruthy();
  });

  test("rejects invalid library names before touching filesystem targets", async () => {
    const outsideDir = join(tempDir, "outside");
    const outsideSentinel = join(outsideDir, "sentinel.txt");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideSentinel, "keep me", "utf-8");

    for (const libraryName of [
      "",
      "../outside",
      "nested/name",
      "nested\\name",
      "bad\0name",
    ]) {
      await expect(
        installLibrarySkill(
          {
            sourceDir,
            libraryName,
            source: "local:/tmp/source",
            sourceType: "local",
            commitHash: "unknown",
            ref: null,
            skillPath: "skills/brainstorming",
            force: true,
          },
          { skillsDir, lockPath },
        ),
      ).rejects.toThrow(/Invalid skill name/);
    }

    await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("keep me");
    await expect(lstat(join(skillsDir, "nested"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readLibraryLock(lockPath)).resolves.toEqual({
      version: 1,
      skills: {},
    });
  });
});

describe("activateLibrarySkill", () => {
  let tempDir: string;
  let libraryPath: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asm-library-activate-"));
    libraryPath = join(tempDir, "library", "skills", "brainstorming");
    targetDir = join(tempDir, "provider", "skills");
    await mkdir(libraryPath, { recursive: true });
    await writeFile(
      join(libraryPath, "SKILL.md"),
      "---\nname: brainstorming\n---\n# Brainstorming\n",
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates a symlink from provider target to library skill", async () => {
    const result = await activateLibrarySkill({
      libraryPath,
      targetDir,
      activationName: "brainstorming",
      force: false,
    });

    const symlinkPath = join(targetDir, "brainstorming");
    expect(result).toEqual({ symlinkPath, targetPath: libraryPath });
    await expect(readlink(symlinkPath)).resolves.toBe(libraryPath);
    await expect(lstat(symlinkPath)).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
  });

  test("refuses an existing target without force", async () => {
    const symlinkPath = join(targetDir, "brainstorming");
    const existingPath = join(tempDir, "existing");
    await mkdir(targetDir, { recursive: true });
    await mkdir(existingPath, { recursive: true });
    await symlink(existingPath, symlinkPath, "dir");

    await expect(
      activateLibrarySkill({
        libraryPath,
        targetDir,
        activationName: "brainstorming",
        force: false,
      }),
    ).rejects.toThrow(
      `Target already exists: ${symlinkPath}. Use --force to overwrite.`,
    );

    await expect(readlink(symlinkPath)).resolves.toBe(existingPath);
  });

  test("rejects invalid activation names before touching filesystem targets", async () => {
    const outsideDir = join(tempDir, "provider", "outside");
    const outsideSentinel = join(outsideDir, "sentinel.txt");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideSentinel, "keep me", "utf-8");

    for (const activationName of [
      "",
      "../outside",
      "nested/name",
      "nested\\name",
      "bad\0name",
    ]) {
      await expect(
        activateLibrarySkill({
          libraryPath,
          targetDir,
          activationName,
          force: true,
        }),
      ).rejects.toThrow(/Invalid skill name/);
    }

    await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("keep me");
    await expect(lstat(join(targetDir, "nested"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

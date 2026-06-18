import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  emptyLibraryLock,
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

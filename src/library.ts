import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { getLibraryLockPath } from "./config";
import { debug } from "./logger";
import type { LibraryLockFile } from "./utils/types";

export function emptyLibraryLock(): LibraryLockFile {
  return { version: 1, skills: {} };
}

export async function readLibraryLock(
  path: string = getLibraryLockPath(),
): Promise<LibraryLockFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      debug("library: lock file not found, returning empty lock");
      return emptyLibraryLock();
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.skills !== "object" ||
      parsed.skills === null ||
      Array.isArray(parsed.skills)
    ) {
      throw new Error("invalid schema");
    }
    return parsed as LibraryLockFile;
  } catch {
    const backupPath = path + ".bak";
    try {
      await copyFile(path, backupPath);
    } catch {
      // best effort backup
    }
    console.error(
      `Warning: library-lock.json was corrupted. Backup saved to ${backupPath}. Starting fresh.`,
    );
    return emptyLibraryLock();
  }
}

export async function writeLibraryLock(
  lock: LibraryLockFile,
  path: string = getLibraryLockPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

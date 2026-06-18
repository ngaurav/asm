import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "fs/promises";
import { dirname, join } from "path";
import { getLibraryLockPath, getLibrarySkillsDir } from "./config";
import { debug } from "./logger";
import { parseFrontmatter, resolveVersion } from "./utils/frontmatter";
import type { LibraryLockFile } from "./utils/types";

const LIBRARY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_LIBRARY_NAME_LENGTH = 128;

export interface InstallLibrarySkillPlan {
  sourceDir: string;
  libraryName: string;
  source: string;
  sourceType: "registry" | "github" | "local";
  commitHash: string;
  ref: string | null;
  skillPath: string;
  force: boolean;
}

export interface LibraryPaths {
  skillsDir?: string;
  lockPath?: string;
}

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

function validateLibraryName(name: string): string {
  if (!name) {
    throw new Error("Invalid skill name: name cannot be empty");
  }
  if (name.includes("\0")) {
    throw new Error(
      "Invalid skill name: contains unsafe characters (null byte)",
    );
  }
  if (name.includes("..")) {
    throw new Error("Invalid skill name: contains unsafe characters (..)");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(
      "Invalid skill name: contains unsafe characters (path separator)",
    );
  }
  if (name.startsWith(".")) {
    throw new Error("Invalid skill name: must not start with a dot");
  }
  if (name.length > MAX_LIBRARY_NAME_LENGTH) {
    throw new Error(
      `Invalid skill name: exceeds maximum length of ${MAX_LIBRARY_NAME_LENGTH} characters`,
    );
  }
  if (!LIBRARY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name: "${name}" does not match allowed pattern [a-zA-Z0-9][a-zA-Z0-9._-]*`,
    );
  }
  return name;
}

export async function installLibrarySkill(
  plan: InstallLibrarySkillPlan,
  paths: LibraryPaths = {},
): Promise<{ name: string; version: string; libraryPath: string }> {
  const skillsDir = paths.skillsDir ?? getLibrarySkillsDir();
  const lockPath = paths.lockPath ?? getLibraryLockPath();
  const libraryName = validateLibraryName(plan.libraryName);
  const libraryPath = join(skillsDir, libraryName);

  if (await pathExists(libraryPath)) {
    if (!plan.force) {
      throw new Error(
        `Library skill already exists: ${libraryPath}. Use --force to overwrite.`,
      );
    }
    await rm(libraryPath, { recursive: true, force: true });
  }

  await mkdir(skillsDir, { recursive: true });
  await cp(plan.sourceDir, libraryPath, { recursive: true });
  await rm(join(libraryPath, ".git"), { recursive: true, force: true });

  const skillMarkdown = await readFile(join(libraryPath, "SKILL.md"), "utf-8");
  const fm = parseFrontmatter(skillMarkdown);
  const name = fm.name || libraryName;
  const version = resolveVersion(fm);

  const lock = await readLibraryLock(lockPath);
  lock.skills[libraryName] = {
    name,
    version,
    source: plan.source,
    sourceType: plan.sourceType,
    commitHash: plan.commitHash,
    ref: plan.ref,
    skillPath: plan.skillPath,
    libraryPath,
    installedAt: new Date().toISOString(),
  };
  await writeLibraryLock(lock, lockPath);

  return { name, version, libraryPath };
}

import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
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

export interface LibrarySkillInfo {
  dirName: string;
  name: string;
  version: string;
  source: string;
  sourceType?: "registry" | "github" | "local";
  commitHash: string;
  ref: string | null;
  skillPath: string;
  libraryPath: string;
  installedAt: string;
  missing: boolean;
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

export async function listLibrarySkills(
  path: string = getLibraryLockPath(),
): Promise<LibrarySkillInfo[]> {
  const lock = await readLibraryLock(path);
  const rows: LibrarySkillInfo[] = [];

  for (const [dirName, entry] of Object.entries(lock.skills)) {
    let missing = false;
    try {
      await access(join(entry.libraryPath, "SKILL.md"));
    } catch {
      missing = true;
    }
    rows.push({ dirName, ...entry, missing });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export function findLibrarySkill(
  rows: LibrarySkillInfo[],
  name: string,
): LibrarySkillInfo | null {
  const exactDir = rows.find((r) => r.dirName === name);
  if (exactDir) return exactDir;
  const exactName = rows.find((r) => r.name === name);
  return exactName ?? null;
}

export interface DeactivateLibrarySkillInput {
  targetDir: string;
  activationName: string;
  provider: string;
  scope: "global" | "project";
  librarySkillsDir?: string;
}

export interface DeactivateLibrarySkillResult {
  name: string;
  provider: string;
  scope: "global" | "project";
  path: string;
  target: string;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathIfExists(path: string): Promise<{
  path: string;
  exists: boolean;
}> {
  try {
    return { path: await realpath(path), exists: true };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { path: resolve(path), exists: false };
    }
    throw err;
  }
}

export async function deactivateLibrarySkill(
  input: DeactivateLibrarySkillInput,
): Promise<DeactivateLibrarySkillResult> {
  const activationName = validateSkillDirectoryName(input.activationName);
  const symlinkPath = join(input.targetDir, activationName);

  let stat;
  try {
    stat = await lstat(symlinkPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `Skill "${activationName}" is not active for ${input.provider}/${input.scope}.`,
      );
    }
    throw err;
  }

  if (!stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to deactivate non-symlink target: ${symlinkPath}.`,
    );
  }

  const rawTarget = await readlink(symlinkPath);
  const absoluteTarget = isAbsolute(rawTarget)
    ? rawTarget
    : resolve(dirname(symlinkPath), rawTarget);
  const librarySkillsDir = input.librarySkillsDir ?? getLibrarySkillsDir();
  const resolvedTarget = await realpathIfExists(absoluteTarget);
  const resolvedLibrarySkillsDir = await realpathIfExists(librarySkillsDir);
  const useRealPaths = resolvedTarget.exists && resolvedLibrarySkillsDir.exists;
  const targetPathForContainment = useRealPaths
    ? resolvedTarget.path
    : resolve(absoluteTarget);
  const libraryPathForContainment = useRealPaths
    ? resolvedLibrarySkillsDir.path
    : resolve(librarySkillsDir);

  if (!isInsideDirectory(libraryPathForContainment, targetPathForContainment)) {
    throw new Error(
      `Refusing to deactivate symlink outside the ASM library: ${symlinkPath}.`,
    );
  }

  await rm(symlinkPath);

  return {
    name: activationName,
    provider: input.provider,
    scope: input.scope,
    path: symlinkPath,
    target: targetPathForContainment,
  };
}

export async function activateLibrarySkill(input: {
  libraryPath: string;
  targetDir: string;
  activationName: string;
  force: boolean;
}): Promise<{ symlinkPath: string; targetPath: string }> {
  const activationName = validateSkillDirectoryName(input.activationName);
  const symlinkPath = join(input.targetDir, activationName);
  try {
    await lstat(symlinkPath);
    if (!input.force) {
      throw new Error(
        `Target already exists: ${symlinkPath}. Use --force to overwrite.`,
      );
    }
    await rm(symlinkPath, { recursive: true, force: true });
  } catch (err: any) {
    if (err?.message?.includes("--force")) throw err;
  }

  await mkdir(input.targetDir, { recursive: true });
  await symlink(input.libraryPath, symlinkPath, "dir");
  return { symlinkPath, targetPath: input.libraryPath };
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

function validateSkillDirectoryName(name: string): string {
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
  const libraryName = validateSkillDirectoryName(plan.libraryName);
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

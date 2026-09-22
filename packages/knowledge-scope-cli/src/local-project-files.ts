import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import { canonicalJson, parseJsonText } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";

export const ProjectSchema = z.object({ format: z.literal("schift.local-project.v1"), source: z.string().min(1),
  snapshot: z.string().uuid(), mount: KnowledgeScopeMountSchema }).strict();
export type LocalProject = z.infer<typeof ProjectSchema>;
const fileError = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

export const canonicalSelectedPath = async (path: string): Promise<string> => {
  // Canonicalize the already-existing parent (macOS /tmp is a system alias),
  // but never follow a symlink at the selected project directory.
  const selected = resolve(path);
  let ancestor = dirname(selected);
  while (ancestor !== dirname(ancestor)) {
    const entry = await lstat(ancestor);
    if (entry.isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(ancestor))) throw new OnboardingError("project_invalid");
    ancestor = dirname(ancestor);
  }
  if (selected === sep) throw new OnboardingError("project_invalid");
  const parent = await realpath(dirname(selected));
  return join(parent, basename(selected));
};

export const projectDirectory = async (path: string, create = false): Promise<string> => {
  const directory = await canonicalSelectedPath(path);
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!fileError(error, "EEXIST")) throw error; }
  }
  let stat;
  try { stat = await lstat(directory); }
  catch (error) { if (fileError(error, "ENOENT")) throw new OnboardingError("project_missing", { nextAction: "Connect your selected documents first." }); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())) throw new OnboardingError("project_invalid");
  if (create) {
    const entries = await readdir(directory);
    if (entries.length > 0 && !entries.includes(".project-owner")) throw new OnboardingError("project_invalid", { nextAction: "Choose an empty project directory; existing files were not changed." });
    if (entries.length === 0) {
      let marker;
      try { marker = await open(join(directory, ".project-owner"), "wx", 0o600); }
      catch (error) { if (!fileError(error, "EEXIST")) throw error; }
      if (marker !== undefined) await marker.close();
    }
    let ignore;
    try { ignore = await open(join(directory, ".gitignore"), "wx", 0o600); }
    catch (error) { if (!fileError(error, "EEXIST")) throw error; }
    if (ignore !== undefined) {
      try { await ignore.writeFile("*\n"); await ignore.sync(); }
      finally { await ignore.close(); }
    }
  }
  return directory;
};

export const readProject = async (directory: string): Promise<LocalProject | undefined> => {
  const path = join(directory, "project.json");
  if (!constants.O_NOFOLLOW) throw new OnboardingError("project_invalid");
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (fileError(error, "ENOENT")) return undefined; throw new OnboardingError("project_invalid"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) throw new OnboardingError("project_invalid");
    const bytes = Buffer.alloc(65537); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new OnboardingError("project_invalid");
    const after = await handle.stat(); const named = await lstat(path);
    if (after.dev !== named.dev || after.ino !== named.ino || named.isSymbolicLink() || after.nlink !== 1 ||
      stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new OnboardingError("project_invalid");
    const parsed = ProjectSchema.safeParse(parseJsonText(bytes.subarray(0, bytesRead).toString("utf8"), "local project"));
    if (!parsed.success || !parsed.data.source.startsWith("/")) throw new OnboardingError("project_invalid");
    return parsed.data;
  } finally { await handle.close(); }
};

export const writeProject = async (directory: string, project: LocalProject): Promise<void> => {
  const temporary = join(directory, `.project-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${canonicalJson(project)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, join(directory, "project.json"));
};

export const withProjectLock = async <T>(directory: string, action: () => Promise<T>): Promise<T> => {
  const path = join(directory, ".project.lock");
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) { if (fileError(error, "EEXIST")) throw new OnboardingError("project_busy", { nextAction: "Another connection or refresh is in progress. Retry when it finishes. An interrupted lock requires manual review." }); throw error; }
  const owned = await handle.stat();
  try { return await action(); }
  finally {
    await handle.close();
    const current = await lstat(path);
    if (current.dev === owned.dev && current.ino === owned.ino && current.nlink === 1) await unlink(path);
    else throw new OnboardingError("project_invalid");
  }
};

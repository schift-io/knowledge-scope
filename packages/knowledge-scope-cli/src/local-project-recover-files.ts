import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import { canonicalJson, decodeUtf8Strict, parseJsonText } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";
import { projectDirectory, readProject } from "./local-project-files.js";
import { KnowledgeScopeStateSchema } from "./state-contract.js";
import { MAX_STATE_BYTES, MAX_STATE_DEPTH, MAX_STATE_NODES } from "./state-store.js";
import { digest } from "./local-documents/snapshot.js";

export const unsafeRecovery = (): never => { throw new OnboardingError("recover_unsafe", { nextAction: "Recovery only accepts verified KS directories and recognized private legacy locks. No unknown file will be repaired." }); };
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const identity = (stat: Stats) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode, uid: stat.uid, nlink: stat.nlink });
const privateOwner = (stat: Stats): boolean => (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
export const recoveryFile = async (path: string, limit: number) => {
  if (!constants.O_NOFOLLOW) return unsafeRecovery();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !privateOwner(before) || before.size > limit) return unsafeRecovery();
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat(); const named = await lstat(path);
    if (length > limit || named.isSymbolicLink() || canonicalJson(identity(before)) !== canonicalJson(identity(after)) ||
      canonicalJson(identity(after)) !== canonicalJson(identity(named))) return unsafeRecovery();
    const text = decodeUtf8Strict(bytes.subarray(0, length));
    return { text, fingerprint: { ...identity(after), hash: digest(text) } };
  } finally { await handle.close(); }
};
const LegacyOwnerSchema = z.object({ pid: z.number().int().positive().max(2147483647), createdAt: z.number().finite().nonnegative(), nonce: z.string().min(1).max(256) }).strict();
export type RecoveryLock = Readonly<{ path: string; state: "missing" | "healthy" | "legacy"; fingerprint: string }>;
export const inspectRecoveryLock = async (path: string): Promise<RecoveryLock> => {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (missing(error)) return { path, state: "missing", fingerprint: "missing" }; throw error; }
  if (stat.isSymbolicLink() || !privateOwner(stat)) return unsafeRecovery();
  if (stat.isDirectory()) {
    if ((await readdir(path)).length !== 0) return unsafeRecovery();
    return { path, state: "healthy", fingerprint: canonicalJson(identity(stat)) };
  }
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return unsafeRecovery();
  const file = await recoveryFile(path, 4096);
  if (file.text.length !== 0) {
    const owner = LegacyOwnerSchema.safeParse(parseJsonText(file.text, "legacy lock", { maxBytes: 4096 }));
    if (!owner.success) return unsafeRecovery();
    try { process.kill(owner.data.pid, 0); throw new OnboardingError("recover_live_writer"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        if (error instanceof OnboardingError) throw error;
        throw new OnboardingError("recover_live_writer", { nextAction: "Stop all legacy KS writers before recovery. A live or inaccessible process cannot be overridden." });
      }
    }
  } else if (!path.endsWith("/.project.lock")) return unsafeRecovery();
  return { path, state: "legacy", fingerprint: canonicalJson(file.fingerprint) };
};

export const recoveryAuthority = async (directory: string, home: string): Promise<string> => {
  if (await projectDirectory(directory) !== directory || await projectDirectory(home) !== home) return unsafeRecovery();
  const projectStat = await lstat(directory); const homeStat = await lstat(home);
  const stateFile = await recoveryFile(join(home, "state.json"), MAX_STATE_BYTES);
  const state = KnowledgeScopeStateSchema.parse(parseJsonText(stateFile.text, "state.json", { maxBytes: MAX_STATE_BYTES, maxDepth: MAX_STATE_DEPTH, maxNodes: MAX_STATE_NODES }));
  const project = await readProject(directory);
  let proof: string; let installationId: string;
  if (project !== undefined) {
    const copy = await readProject(await projectDirectory(join(directory, project.snapshot)));
    if (copy === undefined || canonicalJson(copy) !== canonicalJson(project)) return unsafeRecovery();
    proof = canonicalJson(project); installationId = project.mount.installationId;
  } else {
    const file = await recoveryFile(join(directory, "installation.json"), 65536);
    const mount = KnowledgeScopeMountSchema.parse(parseJsonText(file.text, "installation"));
    proof = canonicalJson(file.fingerprint); installationId = mount.installationId;
  }
  if (!state.installations.some(entry => entry.mount.installationId === installationId)) return unsafeRecovery();
  return digest(canonicalJson({ directory, home, projectIdentity: [projectStat.dev, projectStat.ino], homeIdentity: [homeStat.dev, homeStat.ino], proof, state: stateFile.fingerprint }));
};

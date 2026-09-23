import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliDependencies } from "./cli.js";
import { canonicalJson, type JsonValue } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";
import { projectDirectory } from "./local-project-files.js";
import { LocalLockError, withLocalGuard } from "./local-lock.js";
import { syncDirectory } from "./durable-file.js";
import { digest } from "./local-documents/snapshot.js";
import { inspectRecoveryLock, recoveryAuthority } from "./local-project-recover-files.js";

export const recoverLocalProject = async (request: Readonly<{ directory: string; apply?: boolean; plan?: string; quiesced?: boolean }>, dependencies: CliDependencies): Promise<JsonValue> => {
  if (request.apply && request.quiesced !== true) throw new OnboardingError("recover_quiescence_required", { nextAction: "Stop every older KS writer using this project or runtime home, then explicitly assert --quiesced. Empty legacy locks have no verifiable owner." });
  if (!request.apply && (request.plan !== undefined || request.quiesced !== undefined)) throw new OnboardingError("argument_invalid");
  const store = dependencies.localState;
  if (store === undefined) throw new OnboardingError("local_recover_unavailable");
  const quarantined: { original: string; quarantine: string }[] = [];
  try {
    const directory = await projectDirectory(request.directory); const home = await projectDirectory(store.home);
    const projectLock = join(directory, ".project.lock"); const stateLock = join(home, "state.lock");
    return await withLocalGuard(projectLock, () => withLocalGuard(stateLock, async () => {
      const authority = await recoveryAuthority(directory, home);
      const locks = [await inspectRecoveryLock(projectLock), await inspectRecoveryLock(stateLock)];
      const plan = digest(canonicalJson({ authority, locks }));
      const details = { directory, home, plan, locks: locks.map(({ path, state }) => ({ path, state })), requiresQuiescence: true };
      if (!request.apply) return { ...details, status: "recovery_preview", note: "Stop all legacy writers before applying. Recovery preserves old lock files in same-directory quarantine; sources and runtime state are not deleted." };
      if (request.plan !== plan) throw new OnboardingError("recover_plan_changed", { nextAction: "Preview recovery again and apply that exact plan only after stopping all legacy writers." });
      for (const lock of locks) {
        if (lock.state !== "legacy") continue;
        if (await recoveryAuthority(directory, home) !== authority || canonicalJson(await inspectRecoveryLock(lock.path)) !== canonicalJson(lock)) throw new OnboardingError("recover_plan_changed");
        const quarantine = join(dirname(lock.path), `.legacy-lock-${randomUUID()}`);
        await rename(lock.path, quarantine); quarantined.push({ original: lock.path, quarantine });
        await syncDirectory(dirname(lock.path));
        await mkdir(lock.path, { mode: 0o700 });
        await syncDirectory(dirname(lock.path));
      }
      return { ...details, status: "recovered", quarantined, note: "Quarantined legacy locks were retained. Original documents, installations, and conversation history were not deleted. Do not restore old locks over permanent directory sentinels." };
    }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (quarantined.length > 0) throw new OnboardingError("recover_partial", { quarantined, nextAction: "Some legacy locks were moved and retained. Do not restore them blindly. Keep legacy writers stopped and inspect the reported paths before retrying." });
    if (error instanceof OnboardingError && ["recover_plan_changed", "recover_live_writer"].includes(error.code)) throw error;
    if (error instanceof LocalLockError) throw new OnboardingError(error.code === "busy" ? "recover_busy" : "local_lock_unavailable");
    throw new OnboardingError("recover_unsafe", { nextAction: "Recovery refused unexpected files or an unverified project/runtime home. Nothing was changed." });
  }
};

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KnowledgeScopeMountSchema, ScopeRequirementReceiptSchema } from "@schift-io/context-pack";
import { z } from "zod";
import type { CliDependencies } from "./cli.js";
import { canonicalJson, type JsonValue } from "./json.js";
import { OnboardingError } from "./onboarding-config.js";
import { prepareLocalSnapshot } from "./local-quickstart.js";
import { canonicalSelectedPath, projectDirectory, readProject, writeProject, withProjectLock, type LocalProject } from "./local-project-files.js";

const note = "Documents stay on this computer as local snapshots. Refresh reads only the selected source. Earlier snapshots remain stored; no automatic upload, model call, or deletion.";
const info = (directory: string, project: LocalProject) => ({ directory, source: project.source,
  installationId: project.mount.installationId, revision: project.mount.revision, storage: "local_snapshot", note });

const requireProject = async (directory: string): Promise<LocalProject> => {
  const project = await readProject(directory);
  if (project === undefined) throw new OnboardingError("project_missing", { nextAction: "Connect your selected documents first." });
  const snapshotDirectory = await projectDirectory(join(directory, project.snapshot));
  const original = await readProject(snapshotDirectory);
  if (original === undefined || canonicalJson(original) !== canonicalJson(project)) throw new OnboardingError("project_invalid");
  return project;
};
const verifyMount = async (project: LocalProject, dependencies: CliDependencies): Promise<void> => {
  const inspection = z.object({ mount: KnowledgeScopeMountSchema }).parse(await dependencies.embedded.inspect(project.mount.installationId));
  if (inspection.mount.state !== "mounted" || canonicalJson(inspection.mount) !== canonicalJson(project.mount)) {
    throw new OnboardingError("installation_mismatch", { nextAction: "This project's connection changed or was revoked. Select a new project explicitly; refresh cannot restore revoked access." });
  }
};
const build = async (request: Readonly<{ directory: string; source: string }>, dependencies: CliDependencies): Promise<LocalProject> => {
  const snapshot = randomUUID();
  const built = z.object({ installationId: z.string() }).parse(await prepareLocalSnapshot({ directory: join(request.directory, snapshot), source: request.source, tenant: "local-tenant" }, dependencies));
  const { mount } = z.object({ mount: KnowledgeScopeMountSchema }).parse(await dependencies.embedded.inspect(built.installationId));
  const project: LocalProject = { format: "schift.local-project.v1", source: request.source, snapshot, mount };
  await writeProject(join(request.directory, snapshot), project);
  return project;
};

export const connectLocalProject = async (request: Readonly<{ directory: string; source: string }>, dependencies: CliDependencies): Promise<JsonValue> => {
  let source: string;
  try {
    const selected = await canonicalSelectedPath(resolve(request.source));
    if ((await lstat(selected)).isSymbolicLink()) throw new OnboardingError("local_source_invalid");
    source = await realpath(selected);
  } catch (error) {
    if (error instanceof Error) throw new OnboardingError("local_source_invalid", { nextAction: "Select an existing readable Markdown or text source without symlink paths." });
    throw error;
  }
  const directory = await projectDirectory(request.directory, true);
  return withProjectLock(directory, async () => {
    const current = await readProject(directory);
    if (current !== undefined) {
      await requireProject(directory);
      if (current.source !== source) throw new OnboardingError("project_source_mismatch", { nextAction: "Use a different project directory to connect different documents. The existing connection was not changed." });
      await verifyMount(current, dependencies);
      return { ...info(directory, current), status: "connected", reused: true };
    }
    const project = await build({ directory, source }, dependencies);
    await writeProject(directory, project);
    return { ...info(directory, project), status: "connected", reused: false };
  });
};

export const refreshLocalProject = async (request: Readonly<{ directory: string }>, dependencies: CliDependencies): Promise<JsonValue> => {
  const directory = await projectDirectory(request.directory);
  return withProjectLock(directory, async () => {
    const current = await requireProject(directory); await verifyMount(current, dependencies);
    if (await canonicalSelectedPath(current.source) !== current.source) throw new OnboardingError("local_source_invalid");
    const project = await build({ directory, source: current.source }, dependencies);
    await verifyMount(current, dependencies);
    await writeProject(directory, project);
    return { ...info(directory, project), status: "refreshed", reused: false };
  });
};

export const askLocalProject = async (request: Readonly<{ directory: string; query: string }>, dependencies: CliDependencies): Promise<JsonValue> => {
  if (request.query.trim().length === 0 || request.query.length > 8192) throw new OnboardingError("argument_invalid");
  const directory = await projectDirectory(request.directory);
  const project = await requireProject(directory); await verifyMount(project, dependencies);
  const result = await dependencies.embedded.run({ installationId: project.mount.installationId, expectedRevision: project.mount.revision,
    operationId: "search", effectiveScope: { tenant: project.mount.scopeAuthority.tenant }, input: { query: request.query } });
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new OnboardingError("project_invalid");
  const parsed = z.object({ receipt: ScopeRequirementReceiptSchema }).parse(result);
  const expired = parsed.receipt.candidateReceipts.some((receipt) => receipt.status === "denied" && receipt.reasonCode === "source_stale");
  return { ...result, ...info(directory, project), ...(expired ? { nextAction: "Evidence expired. Run schift-ks refresh for this project, then ask again." } : {}) };
};

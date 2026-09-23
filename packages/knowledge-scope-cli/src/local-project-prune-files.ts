import { lstat, readdir, open, rename, unlink, rmdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson, parseJsonText } from "./json.js";
import { ProjectSchema, type LocalProject, readProject, projectDirectory, canonicalSelectedPath } from "./local-project-files.js";
import { OnboardingError } from "./onboarding-config.js";
import { readBounded, LOCAL_LIMITS } from "./local-documents/files.js";
import { SnapshotSchema, snapshotId, digest } from "./local-documents/snapshot.js";
import type { StoredKnowledgeScope } from "./state-contract.js";

export const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const invalid = (): never => { throw new OnboardingError("prune_unsafe", {nextAction:"No further deletion was attempted. Review this project's unexpected or corrupt files."}); };
export const privateStat = async (path: string, directory = false, publicRead = false) => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & (publicRead ? 0o022 : 0o077)) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) invalid();
  return stat;
};
export const fileNames = ["bindings.json", "input.json", "installation.json", "pack/scope.json", "pack/scope.lock.json", "pack/schemas/input.json", "pack/schemas/result.json", "project.json"] as const;
const directoryNames = ["pack", "pack/schemas"] as const;
export type Inventory = Readonly<{path: string; bytes: number; hash: string}>;
export const inventory = async (root: string, partial: boolean): Promise<readonly Inventory[]> => {
  try { await privateStat(root,true); } catch(error) { if (partial && missing(error)) return []; throw error; }
  const found: Inventory[] = [];
  const visit = async (suffix: string): Promise<void> => {
    for (const name of await readdir(join(root,suffix))) {
      const path = suffix ? `${suffix}/${name}` : name;
      if (directoryNames.some(entry=>entry===path)) { await privateStat(join(root,path),true); await visit(path); }
      else if (fileNames.some(entry=>entry===path)) {
        const publicRead=path==="pack/scope.lock.json";
        const stat = await privateStat(join(root,path),false,publicRead);
        const text = await readBounded(join(root,path),1048576,!publicRead);
        found.push({path:join(root,path),bytes:stat.size,hash:digest(text)});
      } else invalid();
    }
  };
  await visit("");
  if (!partial && found.length !== fileNames.length) invalid();
  return found.sort((a,b)=>a.path.localeCompare(b.path));
};
export const rawSnapshot = async (home: string, ref: string, source: string, partial: boolean): Promise<Inventory | undefined> => {
  if (!/^local:[a-f0-9]{64}$/u.test(ref)) invalid();
  await projectDirectory(home); await projectDirectory(join(home,"local-documents"));
  const path = join(home,"local-documents",`${ref.slice(6)}.json`);
  let stat; try { stat=await privateStat(path); } catch(error) { if(partial&&missing(error)) return undefined; throw error; }
  const text = await readBounded(path,LOCAL_LIMITS.snapshotBytes,true);
  const snapshot = SnapshotSchema.parse(parseJsonText(text,"snapshot",{maxBytes:LOCAL_LIMITS.snapshotBytes}));
  if(snapshotId(snapshot)!==ref) invalid();
  for (const doc of snapshot.documents) {
    const uri = new URL(doc.uri); if(uri.protocol!=="file:"||uri.host!==""||uri.search||uri.hash) invalid();
    const pathRelative=relative(source,fileURLToPath(uri));
    if(pathRelative===".."||pathRelative.startsWith(`..${sep}`)||doc.revision!==`sha256:${digest(doc.text)}`) invalid();
  }
  return {path,bytes:stat.size,hash:digest(text)};
};
export const JournalSchema = z.object({format:z.literal("schift.prune-pending.v1"), projects:z.array(ProjectSchema).min(1).max(10000)}).strict();
export const readJournal = async (directory:string): Promise<readonly LocalProject[]> => {
  const path=join(directory,".prune-pending.json");
  try { await privateStat(path); } catch(error) { if(missing(error)) return []; throw error; }
  return JournalSchema.parse(parseJsonText(await readBounded(path,16777216,true),"prune journal",{maxBytes:16777216})).projects;
};
export const writeJournal = async (directory:string, projects:readonly LocalProject[]):Promise<void> => {
  const serialized=canonicalJson({format:"schift.prune-pending.v1",projects});
  JournalSchema.parse(parseJsonText(serialized,"prune journal",{maxBytes:16777216}));
  const temporary=join(directory,`.prune-${randomUUID()}.tmp`);
  const handle=await open(temporary,"wx",0o600);
  try { await handle.writeFile(serialized); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary,join(directory,".prune-pending.json")); await syncDirectory(directory);
};
export const syncDirectory = async(path:string):Promise<void> => {
  const handle=await open(path,"r"); try { await handle.sync(); } finally { await handle.close(); }
};
export const removeRevision = async(directory:string, files:readonly Inventory[]):Promise<void> => {
  for (const file of files) {
    if(await canonicalSelectedPath(file.path)!==file.path) invalid();
    const publicRead=file.path.endsWith("/pack/scope.lock.json");
    const stat=await privateStat(file.path,false,publicRead);
    if(stat.size!==file.bytes||digest(await readBounded(file.path,LOCAL_LIMITS.snapshotBytes,!publicRead))!==file.hash) invalid();
    await unlink(file.path);
  }
  for (const suffix of ["pack/schemas","pack",""]) {
    try { await rmdir(join(directory,suffix)); } catch(error) { if(!missing(error)) throw error; }
  }
};
export const currentProject = async(directory:string):Promise<LocalProject> => {
  const current=await readProject(directory); if(current===undefined) return invalid();
  const copy=await readProject(await projectDirectory(join(directory,current.snapshot)));
  if(copy===undefined||canonicalJson(copy)!==canonicalJson(current)) invalid();
  return current;
};
export const verifyMetadata = async(root:string,project:LocalProject,stored:StoredKnowledgeScope|undefined,files:readonly Inventory[]):Promise<void> => {
  if(stored===undefined) { if(files.length!==0) invalid(); return; }
  const expected = new Map<string,unknown>([
    ["project.json",project],["installation.json",project.mount],
    ["pack/scope.json",stored.definition],["pack/scope.lock.json",stored.lock],
    ["bindings.json",{scopeAuthority:project.mount.scopeAuthority,sourceBindings:project.mount.sourceBindings}],
    ["input.json",{effectiveScope:{tenant:project.mount.scopeAuthority.tenant},input:{query:""}}],
    ["pack/schemas/input.json",stored.files["schemas/input.json"]],
    ["pack/schemas/result.json",stored.files["schemas/result.json"]],
  ]);
  for(const file of files) {
    const suffix=relative(root,file.path).split(sep).join("/");
    const text=await readBounded(file.path,1048576,suffix!=="pack/scope.lock.json");
    if(JSON.stringify(expected.get(suffix))===undefined||canonicalJson(parseJsonText(text,"revision metadata"))!==canonicalJson(parseJsonText(JSON.stringify(expected.get(suffix)),"expected metadata"))) invalid();
  }
};

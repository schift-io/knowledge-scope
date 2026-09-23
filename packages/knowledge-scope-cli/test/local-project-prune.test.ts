import { expect, it } from "bun:test";
import { mkdtemp, writeFile, readdir, readFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCliDependencies } from "../src/main.js";
import { connectLocalProject, refreshLocalProject, askLocalProject } from "../src/local-project.js";
import { pruneLocalProject } from "../src/local-project-prune.js";
import { KnowledgeScopeStateStore } from "../src/state-store.js";
import type { KnowledgeScopeState } from "../src/state-contract.js";
import { readProject, writeProject } from "../src/local-project-files.js";
import { parseJsonText } from "../src/json.js";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-prune-"));
  const source = join(root, "notes.md"), directory = join(root, "project"), home = join(root, "state");
  const dependencies = createCliDependencies({home, environment: {}});
  await writeFile(source, "Refund seven days.");
  await connectLocalProject({source, directory}, dependencies);
  await writeFile(source, "Refund thirty days.");
  await refreshLocalProject({directory}, dependencies);
  return {root, source, directory, home, dependencies};
};
it("previews obsolete revisions without changing runtime state", async () => {
  // Given
  const f = await fixture(); const before = await readFile(join(f.home, "state.json"), "utf8");
  // When
  const result = await pruneLocalProject({directory: f.directory, keep: 1}, f.dependencies);
  // Then
  expect(result).toMatchObject({status: "preview", obsoleteInstallations: expect.arrayContaining([expect.any(String)])});
  expect(await readFile(join(f.home, "state.json"), "utf8")).toBe(before);
  expect((await readdir(join(f.home, "local-documents"))).length).toBe(2);
});
it("rejects a stale confirmation without removing any snapshot", async()=>{
  // Given
  const f=await fixture(); const before=await readFile(join(f.home,"state.json"),"utf8");
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:"wrong"},f.dependencies)).rejects.toMatchObject({code:"prune_plan_changed"});
  expect(await readFile(join(f.home,"state.json"),"utf8")).toBe(before);
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(2);
});
it("refuses unknown files in an obsolete revision",async()=>{
  // Given
  const f=await fixture(); const current=await readProject(f.directory);
  const old=(await readdir(f.directory)).find(name=>z.string().uuid().safeParse(name).success&&name!==current?.snapshot);
  if(old===undefined) throw new Error("missing fixture");
  await writeFile(join(f.directory,old,"keep-me.txt"),"user-owned",{mode:0o600});
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep:1},f.dependencies)).rejects.toMatchObject({code:"prune_unsafe"});
  expect(await readFile(join(f.directory,old,"keep-me.txt"),"utf8")).toBe("user-owned");
});
it("refuses a symlink substituted for an obsolete raw snapshot",async()=>{
  // Given
  const f=await fixture(); const preview=z.object({snapshots:z.array(z.object({path:z.string()}))}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  const path=preview.snapshots[0]?.path; if(path===undefined) throw new Error("missing fixture");
  await unlink(path); await symlink(f.source,path);
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep:1},f.dependencies)).rejects.toMatchObject({code:"prune_unsafe"});
  expect(await readFile(f.source,"utf8")).toBe("Refund thirty days.");
});
it("retains raw data referenced by another mounted installation",async()=>{
  // Given
  const f=await fixture(); const store=new KnowledgeScopeStateStore({home:f.home});
  const state=await store.read(); const old=state.installations[0]; if(old===undefined) throw new Error("missing fixture");
  await f.dependencies.embedded.mount({definition:parseJsonText(JSON.stringify(old.definition),"definition"),lock:old.lock,files:old.files,scopeAuthority:{...old.mount.scopeAuthority,tenant:"other-project"},sourceBindings:parseJsonText(JSON.stringify(old.mount.sourceBindings),"bindings")});
  const preview=z.object({plan:z.string(),retainedSharedRefs:z.array(z.string())}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect(preview.retainedSharedRefs.length).toBe(1);
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(2);
  expect((await store.read()).installations.length).toBe(2);
});
class InterruptedStore extends KnowledgeScopeStateStore {
  public override async withMaintenance<T>(action:(state:KnowledgeScopeState,persist:(next:KnowledgeScopeState)=>Promise<void>)=>Promise<T>):Promise<T> {
    return super.withMaintenance(async(state,persist)=>{
      let writes=0;
      return action(state,async(next)=>{writes++; if(writes===2) throw new Error("simulated final persistence interruption"); await persist(next);});
    });
  }
}
it("retries cleanup after deletion completed but final state persistence failed",async()=>{
  // Given
  const f=await fixture(); const preview=z.object({plan:z.string()}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  await expect(pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},{...f.dependencies,localState:new InterruptedStore({home:f.home})})).rejects.toMatchObject({code:"prune_partial"});
  const retry=z.object({plan:z.string()}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  const result=await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:retry.plan},f.dependencies);
  // Then
  expect(result).toMatchObject({status:"pruned"});
  expect((await new KnowledgeScopeStateStore({home:f.home}).read()).installations.length).toBe(1);
  expect((await readdir(f.directory))).not.toContain(".prune-pending.json");
});
it("applies the confirmed plan while retaining the active revision", async () => {
  // Given
  const f = await fixture(); const preview = z.object({plan: z.string()}).parse(await pruneLocalProject({directory:f.directory, keep:1},f.dependencies));
  // When
  const result = await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect(result).toMatchObject({status:"pruned"});
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(1);
  expect(z.object({installations:z.array(z.unknown())}).parse(JSON.parse(await readFile(join(f.home,"state.json"),"utf8"))).installations.length).toBe(1);
  expect(JSON.stringify(await askLocalProject({directory:f.directory,query:"Refund"},f.dependencies))).toContain("thirty days");
});
it("rejects changed ownership metadata before revoking any installation",async()=>{
  // Given
  const f=await fixture(); const current=await readProject(f.directory);
  const name=(await readdir(f.directory)).find(item=>z.string().uuid().safeParse(item).success&&item!==current?.snapshot);
  if(name===undefined) throw new Error("missing fixture");
  const project=await readProject(join(f.directory,name)); if(project===undefined) throw new Error("missing fixture");
  await writeProject(join(f.directory,name),{...project,source:join(f.root,"unrelated.md")});
  const before=await readFile(join(f.home,"state.json"),"utf8");
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep:1},f.dependencies)).rejects.toMatchObject({code:"prune_unsafe"});
  expect(await readFile(join(f.home,"state.json"),"utf8")).toBe(before);
});
it("rejects replaced valid JSON that does not match the runtime metadata",async()=>{
  // Given
  const f=await fixture(); const current=await readProject(f.directory);
  const name=(await readdir(f.directory)).find(item=>z.string().uuid().safeParse(item).success&&item!==current?.snapshot);
  if(name===undefined) throw new Error("missing fixture");
  const path=join(f.directory,name,"input.json");
  await writeFile(path,'{"private":"not a generated artifact"}',{mode:0o600});
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep:1},f.dependencies)).rejects.toMatchObject({code:"prune_unsafe"});
  expect(await readFile(path,"utf8")).toContain("not a generated artifact");
});
it("bounds snapshot and installation counts through repeated explicit prune cycles",async()=>{
  // Given
  const f=await fixture();
  // When
  for(let revision=0;revision<4;revision++) {
    await writeFile(f.source,`Refund policy revision ${revision}.`);
    await refreshLocalProject({directory:f.directory},f.dependencies);
    const preview=z.object({plan:z.string()}).parse(await pruneLocalProject({directory:f.directory},f.dependencies));
    await pruneLocalProject({directory:f.directory,apply:true,plan:preview.plan},f.dependencies);
  }
  // Then
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(2);
  expect((await new KnowledgeScopeStateStore({home:f.home}).read()).installations.length).toBe(2);
  expect((await readdir(f.directory)).filter(name=>z.string().uuid().safeParse(name).success).length).toBe(2);
  expect(await readFile(f.source,"utf8")).toBe("Refund policy revision 3.");
});
it.each([0,-1,101,1.5,Number.NaN])("rejects invalid retention %s",async(keep)=>{
  // Given
  const f=await fixture();
  // When / Then
  await expect(pruneLocalProject({directory:f.directory,keep},f.dependencies)).rejects.toMatchObject({code:"argument_invalid"});
});
it("cleans an owned failed empty-source build after a successful retry",async()=>{
  // Given
  const f=await fixture(); await writeFile(f.source,"");
  await expect(refreshLocalProject({directory:f.directory},f.dependencies)).rejects.toBeDefined();
  await writeFile(f.source,"Refund restored."); await refreshLocalProject({directory:f.directory},f.dependencies);
  const preview=z.object({plan:z.string(),failedBuilds:z.array(z.string())}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect(preview.failedBuilds.length).toBe(1);
  expect((await readdir(f.directory)).filter(name=>name.startsWith(".build-pending-")).length).toBe(0);
  expect((await readdir(f.directory)).filter(name=>z.string().uuid().safeParse(name).success).length).toBe(1);
});
it("reclaims journaled raw data when authoring fails before mount",async()=>{
  // Given
  const f=await fixture(); await writeFile(f.source,"Refund interrupted.");
  await expect(refreshLocalProject({directory:f.directory},{...f.dependencies,authoring:{...f.dependencies.authoring,lock:async()=>{throw new Error("simulated authoring failure");}}})).rejects.toBeDefined();
  const preview=z.object({plan:z.string(),failedBuilds:z.array(z.string())}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect(preview.failedBuilds.length).toBe(1);
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(1);
  expect(JSON.stringify(await askLocalProject({directory:f.directory,query:"Refund"},f.dependencies))).toContain("thirty days");
});
it("validates and reclaims a completed lock artifact after mount preparation fails",async()=>{
  // Given
  const f=await fixture(); await writeFile(f.source,"Refund interrupted after lock.");
  await expect(refreshLocalProject({directory:f.directory},{...f.dependencies,authoring:{...f.dependencies.authoring,mountPayload:async()=>{throw new Error("simulated mount preparation failure");}}})).rejects.toBeDefined();
  const preview=z.object({plan:z.string()}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(1);
});
it("reconciles unique build ownership after mount commits but its result is interrupted",async()=>{
  // Given
  const f=await fixture(); await writeFile(f.source,"Refund interrupted after committed mount.");
  await expect(refreshLocalProject({directory:f.directory},{...f.dependencies,embedded:{...f.dependencies.embedded,mount:async(request)=>{await f.dependencies.embedded.mount(request); throw new Error("simulated postcommit interruption");}}})).rejects.toBeDefined();
  const preview=z.object({plan:z.string(),obsoleteInstallations:z.array(z.string())}).parse(await pruneLocalProject({directory:f.directory,keep:1},f.dependencies));
  // When
  await pruneLocalProject({directory:f.directory,keep:1,apply:true,plan:preview.plan},f.dependencies);
  // Then
  expect(preview.obsoleteInstallations.length).toBe(2);
  expect((await new KnowledgeScopeStateStore({home:f.home}).read()).installations.length).toBe(1);
  expect((await readdir(join(f.home,"local-documents"))).length).toBe(1);
  expect((await readdir(f.directory)).filter(name=>name.startsWith(".build-pending-")).length).toBe(0);
});

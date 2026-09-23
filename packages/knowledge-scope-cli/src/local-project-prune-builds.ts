import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { KnowledgeScopeMountSchema } from "@schift-io/context-pack";
import { canonicalJson, parseJsonText } from "./json.js";
import { readBounded } from "./local-documents/files.js";
import { privateStat, syncDirectory, missing, invalid } from "./local-project-prune-files.js";
import type { KnowledgeScopeState } from "./state-contract.js";
import { digest } from "./local-documents/snapshot.js";
import { OnboardingError } from "./onboarding-config.js";
export const BuildIntentSchema=z.object({format:z.literal("schift.local-build.v1"),source:z.string().startsWith("/"),snapshot:z.string().uuid(),packId:z.string().optional(),indexRef:z.string().regex(/^local:[a-f0-9]{64}$/u).optional(),mount:KnowledgeScopeMountSchema.optional(),files:z.record(z.string()).default({})}).strict();
export type BuildIntent=z.infer<typeof BuildIntentSchema>;
export const intentPath=(directory:string,snapshot:string):string=>join(directory,`.build-pending-${z.string().uuid().parse(snapshot)}.json`);
export const writeBuildIntent=async(directory:string,intent:BuildIntent):Promise<void>=>{
  const value=BuildIntentSchema.parse(intent); const temporary=join(directory,`.build-write-${randomUUID()}.tmp`);
  const handle=await open(temporary,"wx",0o600);
  try {await handle.writeFile(canonicalJson(value)); await handle.sync();} finally {await handle.close();}
  await rename(temporary,intentPath(directory,value.snapshot)); await syncDirectory(directory);
};
export const readBuildIntent=async(directory:string,name:string):Promise<BuildIntent>=>{
  const match=/^\.build-pending-([a-f0-9-]{36})\.json$/u.exec(name); if(match?.[1]===undefined) return invalid();
  const path=intentPath(directory,match[1]); await privateStat(path);
  const intent=BuildIntentSchema.parse(parseJsonText(await readBounded(path,1048576,true),"build intent"));
  if(intent.snapshot!==match[1]) invalid(); return intent;
};
export const finishBuildIntent=async(directory:string,snapshot:string):Promise<void>=>{
  try {await unlink(intentPath(directory,snapshot));} catch(error) {if(!missing(error)) throw error;}
  await syncDirectory(directory);
};
export const reconcileBuildIntent=(intent:BuildIntent,state:KnowledgeScopeState):BuildIntent=>{
  if(intent.mount!==undefined||intent.indexRef===undefined) return intent;
  if(intent.packId!==`local-project-${intent.snapshot}`) {
    if(state.installations.some(item=>item.mount.state==="mounted"&&item.mount.sourceBindings.some(binding=>binding.providerRef===intent.indexRef))) {
      throw new OnboardingError("prune_ownership_unresolved",{nextAction:"Legacy interrupted build ownership is ambiguous. Its journal and snapshots were retained for manual review."});
    }
    return intent;
  }
  const candidates=state.installations.filter(item=>item.definition.packId===intent.packId);
  if(candidates.length>1) return invalid();
  const stored=candidates[0]; if(stored===undefined) return intent;
  const hash=(value:unknown):string=>digest(canonicalJson(parseJsonText(JSON.stringify(value),"build ownership")));
  if(stored.mount.state!=="mounted"||hash(stored.definition)!==intent.files["pack/scope.json"]||hash(stored.lock)!==intent.files["pack/scope.lock.json"]||
    hash({scopeAuthority:stored.mount.scopeAuthority,sourceBindings:stored.mount.sourceBindings})!==intent.files["bindings.json"]||
    stored.mount.sourceBindings.length!==1||stored.mount.sourceBindings[0]?.providerRef!==intent.indexRef) return invalid();
  return {...intent,mount:stored.mount};
};

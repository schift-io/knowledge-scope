import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { relative, sep } from "node:path";
import type { CliDependencies } from "./cli.js";
import { canonicalJson, type JsonValue } from "./json.js";
import { readProject, projectDirectory, withProjectLock, type LocalProject } from "./local-project-files.js";
import { OnboardingError } from "./onboarding-config.js";
import { digest } from "./local-documents/snapshot.js";
import { currentProject, invalid, inventory, privateStat, rawSnapshot, readJournal, writeJournal, removeRevision, syncDirectory, verifyMetadata, type Inventory } from "./local-project-prune-files.js";
import { readBuildIntent, finishBuildIntent, reconcileBuildIntent, writeBuildIntent } from "./local-project-prune-builds.js";
import { readBounded } from "./local-documents/files.js";
import { parseJsonText } from "./json.js";

export const pruneLocalProject = async(request:Readonly<{directory:string;keep?:number;apply?:boolean;plan?:string}>,dependencies:CliDependencies):Promise<JsonValue> => {
  const keep=request.keep??2;
  if(!Number.isInteger(keep)||keep<1||keep>100) throw new OnboardingError("argument_invalid");
  const store=dependencies.localState;
  if(store===undefined) throw new OnboardingError("local_prune_unavailable");
  const directory=await projectDirectory(request.directory);
  await projectDirectory(store.home); await privateStat(join(store.home,"state.json"));
  return withProjectLock(directory,async()=>store.withMaintenance(async(state,persist)=>{
    await privateStat(join(directory,".project-owner"));
    const current=await currentProject(directory); const pending=await readJournal(directory);
    const entries=await readdir(directory); if(entries.length>10010) invalid();
    const intents=(await Promise.all(entries.filter(name=>name.startsWith(".build-pending-")).map(name=>readBuildIntent(directory,name)))).map(intent=>reconcileBuildIntent(intent,state));
    if(intents.some(item=>item.source!==current.source)) invalid();
    const projects:LocalProject[]=[];
    for(const name of entries) {
      if(!z.string().uuid().safeParse(name).success) continue;
      const path=join(directory,name); await projectDirectory(path);
      const project=await readProject(path);
      const prior=pending.find(item=>item.snapshot===name);
      if(project===undefined) { if(prior!==undefined) projects.push(prior); else if(!intents.some(item=>item.snapshot===name)) invalid(); }
      else { if(project.snapshot!==name||project.source!==current.source) invalid(); projects.push(project); }
    }
    for(const item of pending) if(!projects.some(project=>project.snapshot===item.snapshot)) projects.push(item);
    for(const item of intents) if(item.mount!==undefined&&!projects.some(project=>project.snapshot===item.snapshot)) projects.push({format:"schift.local-project.v1",source:item.source,snapshot:item.snapshot,mount:item.mount});
    if(new Set(projects.map(item=>item.mount.installationId)).size!==projects.length) invalid();
    const mounted=state.installations.find(item=>item.mount.installationId===current.mount.installationId);
    if(mounted===undefined||canonicalJson(mounted.mount)!==canonicalJson(current.mount)||mounted.mount.state!=="mounted") invalid();
    const position=new Map(state.installations.map((item,index)=>[item.mount.installationId,index]));
    const historical=projects.filter(item=>item.snapshot!==current.snapshot).sort((a,b)=>(position.get(b.mount.installationId)??-1)-(position.get(a.mount.installationId)??-1)||a.snapshot.localeCompare(b.snapshot));
    const obsolete=historical.filter((item,index)=>index>=keep-1||pending.some(old=>old.snapshot===item.snapshot)||intents.some(old=>old.snapshot===item.snapshot));
    if(pending.some(item=>item.snapshot===current.snapshot)) invalid();
    const ids=new Set(obsolete.map(item=>item.mount.installationId));
    const raw=new Map<string,Inventory>(); const shared=new Set<string>(); const metadata=new Map<string,readonly Inventory[]>();
    for(const project of obsolete) {
      if(project.source!==current.source) invalid();
      const intent=intents.find(item=>item.snapshot===project.snapshot);
      const partial=pending.some(item=>canonicalJson(item)===canonicalJson(project))||intent!==undefined;
      const stored=state.installations.find(item=>item.mount.installationId===project.mount.installationId);
      if(stored===undefined&&!partial) invalid();
      const expectedRevoked={...project.mount,state:"unmounted",sourceBindings:[],revision:project.mount.revision+1};
      if(stored!==undefined&&canonicalJson(stored.mount)!==canonicalJson(project.mount)&&canonicalJson(stored.mount)!==canonicalJson(expectedRevoked)) invalid();
      const bindings=project.mount.sourceBindings;
      const binding=bindings[0];
      if(bindings.length!==1||binding===undefined||binding.providerRef===undefined) return invalid();
      const ref=binding.providerRef;
      if(!/^local:[a-f0-9]{64}$/u.test(ref)||binding.permissionMode!=="static"||binding.sourceClass!=="document") invalid();
      if(stored!==undefined&&stored.definition.capabilities.some(item=>item.provider.kind!=="local_documents"||item.provider.indexRef!==ref)) invalid();
      const revisionFiles=await inventory(join(directory,project.snapshot),partial);
      if(intent===undefined) await verifyMetadata(join(directory,project.snapshot),project,stored,revisionFiles);
      metadata.set(project.snapshot,revisionFiles);
      const snapshot=await rawSnapshot(store.home,ref,project.source,partial);
      const referenced=state.installations.some(item=>!ids.has(item.mount.installationId)&&item.mount.state==="mounted"&&
        (item.mount.sourceBindings.some(binding=>binding.providerRef===ref)||item.definition.capabilities.some(cap=>cap.provider.kind==="local_documents"&&cap.provider.indexRef===ref)));
      if(stored===undefined&&snapshot!==undefined&&!referenced) invalid();
      if(referenced) shared.add(ref); else if(snapshot!==undefined) raw.set(ref,snapshot);
    }
    const failed=intents.filter(item=>item.snapshot!==current.snapshot);
    for(const intent of failed) {
      const root=join(directory,intent.snapshot); const revisionFiles=await inventory(root,true);
      for(const file of revisionFiles) {
        const name=relative(root,file.path).split(sep).join("/");
        const value=parseJsonText(await readBounded(file.path,1048576,name!=="pack/scope.lock.json"),"build artifact");
        if(intent.files[name]!==digest(canonicalJson(value))) invalid();
      }
      metadata.set(intent.snapshot,revisionFiles);
      if(intent.indexRef!==undefined) {
        const snapshot=await rawSnapshot(store.home,intent.indexRef,intent.source,true);
        const ref=intent.indexRef;
        const referenced=state.installations.some(item=>!ids.has(item.mount.installationId)&&item.mount.state==="mounted"&&(item.mount.sourceBindings.some(binding=>binding.providerRef===ref)||item.definition.capabilities.some(cap=>cap.provider.kind==="local_documents"&&cap.provider.indexRef===ref)));
        if(referenced) shared.add(ref); else if(snapshot!==undefined) raw.set(ref,snapshot);
      }
    }
    const files=[...metadata.values()].flat(); const snapshots=[...raw.values()].sort((a,b)=>a.path.localeCompare(b.path));
    const details={directory,keep,currentInstallation:current.mount.installationId,obsoleteInstallations:[...ids].sort(),
      failedBuilds:failed.map(item=>join(directory,item.snapshot)).sort(),
      snapshotDirectories:[...metadata.keys()].map(snapshot=>join(directory,snapshot)).sort(),snapshots:snapshots.map(item=>({path:item.path,bytes:item.bytes})),
      retainedSharedRefs:[...shared].sort(),bytes:files.reduce((sum,file)=>sum+file.bytes,0)+snapshots.reduce((sum,file)=>sum+file.bytes,0)};
    const plan=digest(canonicalJson({details,stateRevision:state.revision,files,snapshots,intents}));
    if(!request.apply) return {...details,plan,status:"preview"};
    if(request.plan!==plan) throw new OnboardingError("prune_plan_changed",{nextAction:"Preview prune again and explicitly apply its current plan token."});
    if(obsolete.length===0&&intents.length===0) return {...details,plan,status:"pruned"};
    for(const intent of intents) await writeBuildIntent(directory,intent);
    if(obsolete.length>0) await writeJournal(directory,obsolete);
    const revoked={...state,revision:state.revision+1,installations:state.installations.map(item=>ids.has(item.mount.installationId)&&item.mount.state==="mounted"?{...item,mount:{...item.mount,state:"unmounted" as const,sourceBindings:[],revision:item.mount.revision+1}}:item)};
    await persist(revoked);
    const deleted:string[]=[];
    try {
      for(const snapshot of snapshots) { await privateStat(snapshot.path); await unlink(snapshot.path); deleted.push(snapshot.path); }
      await syncDirectory(join(store.home,"local-documents"));
      for(const [snapshot,revisionFiles] of metadata) { await removeRevision(join(directory,snapshot),revisionFiles); deleted.push(join(directory,snapshot)); }
      await syncDirectory(directory);
      await persist({...revoked,revision:revoked.revision+1,installations:revoked.installations.filter(item=>!ids.has(item.mount.installationId))});
      if(obsolete.length>0) await unlink(join(directory,".prune-pending.json"));
      for(const intent of intents) await finishBuildIntent(directory,intent.snapshot);
      await syncDirectory(directory);
    } catch(error) {
      if(!(error instanceof Error)) throw error;
      throw new OnboardingError("prune_partial",{deleted,revokedInstallations:[...ids],nextAction:"Old installations are unavailable. Preview prune again to review and finish remaining cleanup; current project and original sources were retained."});
    }
    return {...details,plan,status:"pruned",deleted,note:"Original sources are unchanged. This is deletion, not secure erasure; backups and host conversation history are unaffected."};
  }));
};

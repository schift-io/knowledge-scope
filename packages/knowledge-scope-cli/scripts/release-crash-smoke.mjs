import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkUrl = process.argv[2] ? pathToFileURL(process.argv[2]).href : import.meta.resolve("@schift-io/knowledge-scope");
const { KnowledgeScopeStateStore } = await import(sdkUrl);
const binary = join(dirname(fileURLToPath(sdkUrl)), "main.js");
const root = await mkdtemp(join(tmpdir(), "ks-installed-crash-"));
const home = join(root, "state"); const project = join(root, "project");
const source = join(root, "notes.md");
const cli = (args) => {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: { ...process.env, SCHIFT_KS_HOME: home }, cwd: root, encoding: "utf8", timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

async function killAtReady(program) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Writer did not become ready: ${errors}`)), 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Writer exited before ready: ${errors}`)); });
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("ready")) { clearTimeout(timer); resolve(); }
      });
    });
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}

try {
  await writeFile(source, "Refund requests within fourteen days.\n");
  cli(["connect", source, "--project", project, "--json"]);
  const store = new KnowledgeScopeStateStore({ home, environment: {} });
  const before = await store.read();
  await killAtReady(`import { KnowledgeScopeStateStore } from ${JSON.stringify(sdkUrl)};
    const store = new KnowledgeScopeStateStore({home:${JSON.stringify(home)}, faults:{beforeRename:async()=>{ console.log('ready'); await new Promise(()=>{}); }}});
    await store.transact(state=>({state:{...state,revision:state.revision+1},value:null}));`);
  assert.deepEqual(await store.read(), before);
  await store.transact((state) => ({ state: { ...state, revision: state.revision + 1 }, value: null }));
  await killAtReady(`import { createCliDependencies, runKnowledgeScopeCli } from ${JSON.stringify(sdkUrl)};
    const deps=createCliDependencies({home:${JSON.stringify(home)},environment:{}});
    await runKnowledgeScopeCli(['refresh','--project',${JSON.stringify(project)},'--json'], {...deps,localDocuments:{ingest:async()=>{console.log('ready');await new Promise(()=>{});}}},{stdout:console.log,stderr:console.error});`);
  assert.equal(cli(["ask", "Refund", "--project", project, "--json"]).status, "ready");
  cli(["refresh", "--project", project, "--json"]);
  const preview = cli(["prune", "--project", project, "--keep", "1", "--json"]);
  cli(["prune", "--project", project, "--keep", "1", "--apply", "--plan", preview.plan, "--json"]);
  assert.equal(cli(["ask", "Refund", "--project", project, "--json"]).status, "ready");
  process.stdout.write("Installed Node SIGKILL recovery and interrupted-build cleanup: passed.\n");
} finally { await rm(root, { recursive: true, force: true }); }

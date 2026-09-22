import { readFile } from "node:fs/promises";
import { evaluateRetrieval, compareRetrievalReports, fingerprintRetrievalDataset } from "@schift-io/knowledge-scope";

// Offline synthetic scoring demonstration: these are hand-authored captured results.
// For a real pilot, pin these fingerprints BEFORE executing either retrieval adapter.
const fixture = JSON.parse(await readFile(new URL("./synthetic.json", import.meta.url), "utf8"));
const dataset = fixture.dataset;
const capture = (adapter, results) => ({
  adapter, results,
  datasetFingerprint: fingerprintRetrievalDataset(dataset),
  packDigest: dataset.packDigest,
  sourceSnapshotDigest: dataset.sourceSnapshotDigest,
});
const baseline = evaluateRetrieval({ dataset, capture: capture("synthetic-baseline", fixture.baselineResults), topK: 2 });
const candidate = evaluateRetrieval({ dataset, capture: capture("synthetic-candidate", fixture.candidateResults), topK: 2 });
console.log(JSON.stringify({
  notice: fixture.notice,
  baseline,
  candidate,
  comparison: compareRetrievalReports(baseline, candidate),
}, null, 2));

import { z } from "zod";
import type { JsonValue } from "./json.js";

export const FIRST_USE_HELP = `Find cited evidence in your documents.

  schift-ks connect ./my-documents

Then retrieve evidence:
  schift-ks ask "What is the refund policy?"

Supports local .md and .txt files or a folder.
Keeps local copies; no upload or model calls.
After editing your documents: schift-ks refresh
Use --project <directory> for a separate connection.
Default: .schift-ks in this folder.
Add --json for machine output. Advanced commands: schift-ks --help`;

export const terminalText = (text: string): string => text.replace(
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
const shellArgument = (text: string): string => `'${terminalText(text).replaceAll("'", "'\\''")}'`;
const projectOption = (directory: string): string => directory === ".schift-ks" ? "" : ` --project ${shellArgument(directory)}`;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Conservative display widths cover Korean/CJK and common emoji without a terminal dependency.
const displayWidth = (segment: string): number => /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(segment) ? 2 : 1;
const quoteExcerpt = (text: string): string => text.replaceAll("\r\n", "\n").split("\n").flatMap((paragraph) => {
  const lines: string[] = [];
  let line = ""; let columns = 0;
  for (const { segment } of graphemes.segment(terminalText(paragraph))) {
    const width = displayWidth(segment);
    if (columns + width > 78) {
      const breakAt = line.lastIndexOf(" ");
      if (breakAt > 39) {
        lines.push(`  ${line.slice(0, breakAt)}`);
        const remaining = line.slice(breakAt + 1);
        columns = Array.from(graphemes.segment(remaining)).reduce((sum, entry) => sum + displayWidth(entry.segment), 0);
        line = remaining;
      } else {
        lines.push(`  ${line}`); line = ""; columns = 0;
      }
    }
    line += segment; columns += width;
  }
  lines.push(`  ${line}`);
  return lines;
}).join("\n");
const DisplaySchema = z.object({
  status: z.string(), source: z.string().optional(), directory: z.string().optional(),
  candidates: z.array(z.object({
    payload: z.object({ text: z.string().optional() }).passthrough(),
    citation: z.object({ label: z.string().optional(), uri: z.string() }).optional(),
  }).passthrough()).optional(),
  nextAction: z.string().optional(),
}).passthrough();

export const displayResult = (value: JsonValue, directory: string): string => {
  const result = DisplaySchema.parse(value);
  const project = projectOption(directory);
  switch (result.status) {
    case "connected":
    case "refreshed":
      return `${result.status === "connected" ? "Connected" : "Updated"}: ${terminalText(result.source ?? "selected documents")}\nLocal copies are retained on this computer; no upload or model calls.\nNext: schift-ks ask "Your question"${project}`;
    case "ready": {
      const evidence = (result.candidates ?? []).map((candidate, index) => {
        const citation = candidate.citation;
        return `[${index + 1}] ${terminalText(citation?.label ?? "Source (see --json)")}\n${quoteExcerpt(candidate.payload.text ?? "No text excerpt available.")}`;
      });
      return `Retrieved evidence — not a generated answer. Check relevance before using it.\n\n${evidence.join("\n\n")}\n\nAdd --json for full citation details.`;
    }
    case "insufficient_evidence":
      return result.nextAction === undefined
        ? `No sufficient evidence found; no answer was generated.\nTry words used in your documents.\nIf documents changed or expired: schift-ks refresh${project}`
        : `The saved documents have expired; no answer was generated.\nNext: schift-ks refresh${project}`;
    default:
      return `Evidence is not available for this request.\nCheck your connection: schift-ks refresh${project}`;
  }
};

export const displayError = (code: string, directory: string): string => {
  const project = projectOption(directory);
  switch (code) {
    case "project_missing": return `No documents are connected here.\nNext: schift-ks connect ./my-documents${project}`;
    case "project_source_mismatch": return "This project already uses different documents. Keep it and connect the new\nsource with --project <another-directory>.";
    case "project_busy": return "This connection is being updated. If that command was interrupted, verify\nno update is running before recovering its project lock; otherwise wait,\nthen retry.";
    case "local_source_unsupported": return "Choose a local .md or .txt file, or a folder containing those files.";
    case "local_source_empty": return "No supported text was found.\nChoose a folder containing non-empty .md or .txt files.";
    case "local_source_invalid": return "The selected documents could not be read safely.\nCheck the path and file permissions, then retry.";
    case "argument_missing":
    case "argument_invalid": return "Check the command arguments. Start with: schift-ks help";
    case "project_invalid":
    case "installation_mismatch": return "This connection could not be verified. Check --project and SCHIFT_KS_HOME;\ndo not reuse its evidence.";
    default: return `The request could not be completed (${terminalText(code)}).\nNo answer was generated. Check the selected documents and retry.`;
  }
};

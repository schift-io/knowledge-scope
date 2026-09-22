import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalJson } from "../json.js";
import { collectFiles, readBounded, LOCAL_LIMITS, LocalDocumentError } from "./files.js";

const DocumentSchema = z.object({ uri: z.string().url(), text: z.string().max(LOCAL_LIMITS.fileBytes), revision: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().readonly();
export const SnapshotSchema = z.object({ version: z.literal(1), capturedAt: z.string().datetime(), documents: z.array(DocumentSchema).min(1).max(LOCAL_LIMITS.files).readonly() }).strict().readonly();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Chunk = Readonly<{ document: Snapshot["documents"][number]; text: string; lineStart: number; lineEnd: number; id: string }>;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const snapshotId = (snapshot: Snapshot): string => `local:${digest(canonicalJson(snapshot))}`;

export const buildSnapshot = async (source: string): Promise<Snapshot> => {
  const documents: z.infer<typeof DocumentSchema>[] = []; let bytes = 0;
  for (const file of await collectFiles(source)) {
    const text = await readBounded(file, LOCAL_LIMITS.fileBytes);
    bytes += Buffer.byteLength(text);
    if (bytes > LOCAL_LIMITS.totalBytes) throw new LocalDocumentError("local_limit_exceeded");
    documents.push({ uri: pathToFileURL(file.path).href, text, revision: `sha256:${digest(text)}` });
  }
  return { version: 1, capturedAt: new Date().toISOString(), documents };
};

export const chunksFor = (snapshot: Snapshot): readonly Chunk[] => {
  const chunks: Chunk[] = []; let bytes = 0;
  for (const document of snapshot.documents) {
    const uri = new URL(document.uri);
    if (uri.protocol !== "file:" || uri.host !== "" || uri.search !== "" || uri.hash !== "" || document.revision !== `sha256:${digest(document.text)}`) throw new LocalDocumentError("local_snapshot_invalid");
    bytes += Buffer.byteLength(document.text);
    if (bytes > LOCAL_LIMITS.totalBytes) throw new LocalDocumentError("local_limit_exceeded");
    const lines = document.text.split(/\r?\n/u); let text = ""; let start = 1; let end = 1;
    const flush = (): void => {
      if (text.trim().length > 0) chunks.push({ document, text, lineStart: start, lineEnd: end, id: `chunk:${digest(`${document.uri}:${start}:${end}:${text}`)}` });
      text = "";
      if (chunks.length > LOCAL_LIMITS.chunks) throw new LocalDocumentError("local_limit_exceeded");
    };
    lines.forEach((line, offset) => {
      if (line.length > LOCAL_LIMITS.chunkCharacters) throw new LocalDocumentError("local_limit_exceeded");
      if (text.length + line.length + 1 > LOCAL_LIMITS.chunkCharacters) flush();
      if (text.length === 0) start = offset + 1;
      text += `${text.length === 0 ? "" : "\n"}${line}`; end = offset + 1;
    });
    flush();
  }
  return chunks;
};

export const lexicalTerms = (text: string): readonly string[] => {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.flatMap((word) => /[가-힣]/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))] : [word]))];
};

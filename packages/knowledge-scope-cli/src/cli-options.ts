export class CliUsageError extends Error {
  public override readonly name = "CliUsageError";
  public constructor(public readonly code: string) { super(code); }
}

const specifications: Readonly<Record<string, Readonly<{ count: number; values: readonly string[]; flags?: readonly string[] }>>> = {
  connect: { count: 1, values: ["--project"], flags: ["--json"] },
  ask: { count: 1, values: ["--project"], flags: ["--json"] },
  refresh: { count: 0, values: ["--project"], flags: ["--json"] },
  prune: { count: 0, values: ["--project", "--keep", "--plan"], flags: ["--json", "--apply"] },
  recover: { count: 0, values: ["--project", "--plan"], flags: ["--json", "--apply", "--quiesced"] },
  help: { count: 0, values: [], flags: ["--json"] },
  init: { count: 1, values: [] }, validate: { count: 1, values: [] }, lock: { count: 1, values: [] },
  mount: { count: 1, values: ["--bindings", "--api-url"] },
  inspect: { count: 1, values: ["--api-url"] },
  query: { count: 1, values: ["--query", "--api-url"] },
  run: { count: 2, values: ["--input", "--api-url"] },
  "run-batch": { count: 1, values: ["--input", "--api-url"] },
  admit: { count: 1, values: ["--candidate", "--api-url"] },
  unmount: { count: 1, values: ["--expected-revision", "--api-url"] },
  serve: { count: 0, values: ["--host", "--port"] },
  quickstart: { count: 1, values: ["--source", "--index", "--tenant", "--query"] },
  doctor: { count: 1, values: ["--query"], flags: ["--probe"] },
};

export const parseCliOptions = (command: string, args: readonly string[]): readonly string[] => {
  const spec = specifications[command];
  if (spec === undefined) throw new CliUsageError("command_unknown");
  const positional: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (!value.startsWith("-")) { positional.push(value); continue; }
    if (seen.has(value)) throw new CliUsageError("argument_invalid");
    seen.add(value);
    if (spec.flags?.includes(value)) continue;
    if (!spec.values.includes(value)) throw new CliUsageError("argument_invalid");
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--") || next.length === 0) throw new CliUsageError("argument_invalid");
    index += 1;
  }
  if (positional.length < spec.count) throw new CliUsageError("argument_missing");
  if (positional.length > spec.count) throw new CliUsageError("argument_invalid");
  if (command === "doctor" && seen.has("--probe") !== seen.has("--query")) throw new CliUsageError("argument_invalid");
  if (command === "quickstart" && seen.has("--source") && seen.has("--index")) throw new CliUsageError("argument_invalid");
  if ((command === "prune" || command === "recover") && seen.has("--apply") !== seen.has("--plan")) throw new CliUsageError("argument_invalid");
  if (command === "recover" && seen.has("--apply") !== seen.has("--quiesced")) throw new CliUsageError("argument_invalid");
  return positional;
};

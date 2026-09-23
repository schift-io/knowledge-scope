import { z } from "zod";
import type { JsonValue } from "./json.js";

const PruneSchema = z.object({ plan: z.string().regex(/^[a-f0-9]{64}$/u), keep: z.number().int().min(1),
  obsoleteInstallations: z.array(z.string()), failedBuilds: z.array(z.string()).default([]), bytes: z.number().nonnegative(), retainedSharedRefs: z.array(z.string()) });
const RecoverySchema = z.object({ plan: z.string().regex(/^[a-f0-9]{64}$/u), locks: z.array(z.object({ state: z.string() })) });

export const displayMaintenance = (value: JsonValue, projectOption: string): string => {
  const { status } = z.object({ status: z.string() }).parse(value);
  switch (status) {
    case "preview":
    case "pruned": {
      const result = PruneSchema.parse(value);
      if (status === "pruned") return `Cleanup completed: ${result.obsoleteInstallations.length} old connections removed.\nIncomplete builds cleaned: ${result.failedBuilds.length}.\nCurrent project and original documents are retained.\nDeleted copies are not recoverable without a backup; this is not secure erasure.`;
      if (result.obsoleteInstallations.length === 0 && result.failedBuilds.length === 0) return "Nothing deleted. No obsolete copies need cleanup.";
      return `Nothing deleted. ${result.obsoleteInstallations.length} old connections are proposed for removal.\nIncomplete builds: ${result.failedBuilds.length}.\nReclaimable data: ${result.bytes} bytes. Shared snapshots kept: ${result.retainedSharedRefs.length}.\nCurrent project and original documents will be retained.\nReview exact paths with --json. Deletion needs explicit approval.\nTo apply this plan:\nschift-ks prune${projectOption} --keep ${result.keep} \\\n  --apply \\\n  --plan ${result.plan}`;
    }
    case "recovery_preview": {
      const result = RecoverySchema.parse(value);
      const count = result.locks.filter((lock) => lock.state === "legacy").length;
      if (count === 0) return "Nothing changed. No legacy lock files need recovery.";
      return `Nothing changed. ${count} legacy lock files need review.\nStop all KS writers, including older versions, before applying.\nOld lock files will be moved aside and retained; no documents are deleted.\nAfter confirming all writers are stopped:\nschift-ks recover${projectOption} \\\n  --apply --quiesced \\\n  --plan ${result.plan}`;
    }
    case "recovered": return "Recovery completed. Old lock files were moved aside and retained.\nDocuments and connections were not deleted. Do not remove lock directories.\nYou can now retry the operation with this CLI version.";
    default: return "Maintenance did not return a recognized result. Inspect --json before retrying.";
  }
};

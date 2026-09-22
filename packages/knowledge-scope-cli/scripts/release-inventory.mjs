const supportedPaths = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/(?:index|main|context-pack)\.js$/,
  /^dist\/types\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.d\.ts$/,
  /^examples\/(?:[a-z0-9-]+\/)*[A-Za-z0-9-]+\.(?:json|mjs|md)$/,
  /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/,
];

export function validateReleaseInventory(paths) {
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error("Release inventory is empty or contains duplicate paths");
  }
  for (const path of paths) {
    if (typeof path !== "string" || !supportedPaths.some((pattern) => pattern.test(path))) {
      throw new Error(`Unexpected release artifact path: ${path}`);
    }
  }
}

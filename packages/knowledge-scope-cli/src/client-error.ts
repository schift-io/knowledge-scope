export class KnowledgeScopeClientError extends Error {
  public override readonly name = "KnowledgeScopeClientError";
  public constructor(public readonly code: "request_invalid" | "response_invalid" | "identity_mismatch" | "batch_unsupported") {
    super(code);
  }
}

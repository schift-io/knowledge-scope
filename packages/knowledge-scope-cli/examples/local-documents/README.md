# Retrieve a passage without an account

Requires **0.2.0 or later** and Node.js 20 or later. This handbook is synthetic, not a customer
dataset or an accuracy benchmark.

From your application directory:

```bash
npm install @schift-io/knowledge-scope@0.2.0
npx --no-install schift-ks quickstart ./handbook-project \
  --source ./node_modules/@schift-io/knowledge-scope/examples/local-documents/support-handbook.md \
  --query '환불 규정'
```

No cloud service, token, or model is called. A successful result contains a cited passage describing
the 14-day refund window. The `schift://local-documents/...#Lx-Ly` citation identifies the source and
line range; it is not a public web URL. Preserve its `installationId`, then ask another question:

```bash
npx --no-install schift-ks query '<installation-id>' --query '배송 기간'
```

The delivery passage says 3 to 5 business days. For an English query, use `Refund policy`.
The local engine uses lexical matching, so these examples use wording present in the source.
Do not interpret `ready` as a guarantee of semantic relevance or a correct final answer.

## Pass evidence to your application

Run the included SDK consumer with the default local tenant (`local-tenant`). If you supplied
`--tenant`, use that returned tenant instead:

```bash
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' local-tenant '환불 규정' search
```

It loads the same local state, invokes the mounted `search` operation, prints evidence, and does
not generate an answer. Only use `result.candidates` after `result.status === "ready"`; retain
each citation. Handle `insufficient_evidence` by asking for more information or withholding the
answer. The consumer exits with code 3 in that case.

Replace `--source` with your own UTF-8 `.md` or `.txt` file or folder and choose a new destination
directory. The private snapshot contains copied source text; do not share local state with the
portable Pack. Refresh by creating a new snapshot/mount after source edits. There is no automatic
sync, PDF/URL ingestion, or bundled MCP adapter.

See the [main guide](../../README.md#quickstart) for setup and the
[pilot guide](../../docs/PILOT.md) for real-data acceptance criteria.

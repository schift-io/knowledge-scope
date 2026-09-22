# Knowledge Scope Python contracts

Python 3.12+ models and admission functions for Knowledge Scope. The Python
package validates definitions, mounts, execution requests, candidates, and
admission receipts. Its canonical digests are tested against the TypeScript
fixtures in this repository. It does not provide the TypeScript CLI or an HTTP
client.

Install from this checkout (this package has not been published to PyPI):

```sh
uv pip install ./packages/core/context-pack/python
```

```python
from schift_context_pack_contract import KnowledgeScopeDefinition

definition = KnowledgeScopeDefinition.model_validate_json(scope_json)
print(definition.pack_id)
```

Run verification from this directory:

```sh
uv run --extra dev pytest
uv run --extra dev ruff check .
uv run --extra dev ruff format --check .
uv run --extra dev basedpyright --pythonpath .venv/bin/python
uv build
```

The shared fixture directory remains at
`packages/context-pack/fixtures/knowledge-scope` relative to the repository root.
`manifest.py` contains shared internal model primitives retained from the
Context Pack contract; the public package entry point exposes Knowledge Scope
and JSON/error utilities.

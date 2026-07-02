# Biffo Plugin Manifest Schema Validator

Validates `biffo.plugin.json` against the registry schema.
Used by: CLI install flow, registry CI, SDK register_plugin().

## Usage

```bash
python -m jsonschema -i biffo.plugin.json registry-schema.json
```

Or programmatically:

```python
from jsonschema import validate, ValidationError

with open("registry-schema.json") as f:
    schema = json.load(f)

with open("biffo.plugin.json") as f:
    manifest = json.load(f)

try:
    validate(instance=manifest, schema=schema)
except ValidationError as e:
    print(f"Invalid manifest: {e.message}")
```
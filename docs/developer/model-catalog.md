# Model Catalog

Jean loads model metadata from the coolLabs CDN and falls back to metadata
bundled in `src/services/model-catalog.ts` when the network or cache is
unavailable.

Remote entries are keyed by backend and model ID. A remote model replaces the
bundled model list for Claude and Codex; other backends merge CDN entries ahead
of models discovered from their CLI. Fast variants inherit their base model's
reasoning capability.

## Reasoning capability

Each model can declare at most one reasoning control:

```json
{
  "reasoning": {
    "type": "effort",
    "default": "high",
    "levels": [
      {
        "value": "high",
        "label": "High",
        "description": "Greater reasoning depth"
      }
    ]
  }
}
```

- `type` is `effort` or `thinking`.
- `default` must match one level's `value`.
- `levels` controls ordering, labels, descriptions, and available values in
  desktop, mobile, and Settings UI.
- Effort values are passed through to the selected backend, so the CDN can add
  backend-native values without a Jean release.
- Traditional Claude thinking uses `off`, `think`, `megathink`, and
  `ultrathink`. A numeric value such as `16000` defines a custom
  `MAX_THINKING_TOKENS` budget.
- Omit `reasoning` for models without a control. Set `reasoning` to `null` to
  explicitly remove a bundled capability.

Invalid reasoning metadata is ignored without dropping the model. Jean keeps a
bundled copy of supported capabilities so offline startup has the same controls
until newer CDN metadata is fetched.

The deployed catalog source is
`coollabs-cdn/json/jean/models.json` in the linked coolLabs CDN repository.

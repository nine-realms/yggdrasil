## CLI queries

Query symbol neighborhood:

```bash
npx yggdrasil query symbol-neighborhood --repo C:\path\to\repo --symbol processOrder --depth 2 --limit 100 --edge-limit 500
```

Find direct references to a symbol:

```bash
npx yggdrasil query symbol-references --repo C:\path\to\repo --symbol PrimaryService --limit 200
```

`symbol-references` supports disambiguation and output controls:
- `--matching prefer_qualified|qualified_only|name`
- `--include-external-name-matches`
- `--include-alias-expansion`
- `--output full|files_only`
- `--exclude-self`
- `--test-only`

Find method usage with one-shot disambiguation (recommended for method callsites):

```bash
npx yggdrasil query method-usage --repo C:\path\to\repo --symbol PromotionService.GetUserAreaOfStudyGroups --output files_only
```

`method-usage` automatically resolves by method name first, then falls back to qualified matching when needed.

Get file-centric blast radius (inbound/outbound files):

```bash
npx yggdrasil query references-for-file --repo C:\path\to\repo --file src\services\primary-service.ts --output files_only
```

Estimate impact neighborhood from changed files and/or symbols:

```bash
npx yggdrasil query impact-from-diff --repo C:\path\to\repo --changed src\services\reporting.ts --depth 2 --limit 100 --output files_only
```

`impact-from-diff` supports:
- `--output full|files_only` (default `files_only`)
- `--no-external-touchpoints` (omit external touchpoint annotations)

`files_only` returns compact file impact data (`files` / `impactedFiles`) without node and edge payloads.
Blast-radius expansion is internal-first by default (does not fan out through external framework/API symbols),
while still reporting first-hop external symbols in `externalTouchpoints`.

Trace first-hop process flow from detected or explicit entry symbols:

```bash
npx yggdrasil query process-flow --repo C:\path\to\repo --entries Main,ConfigureServices --limit 100 --edge-limit 500
```

Find related symbol communities from seed symbols or changed files:

```bash
npx yggdrasil query related-clusters --repo C:\path\to\repo --symbols Main --changed src\services\worker.ts --include-members --member-limit 25
```

Rank symbols with hybrid lexical + graph scoring:

```bash
npx yggdrasil query hybrid-search --repo C:\path\to\repo --query processOrder --depth 2 --limit 50 --output full
```
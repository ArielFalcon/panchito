# static-signal

App-agnostic static analysis layer. Runs in the background after generation and records structural
signals about each commit (changed symbols, relations, complexity hotspots, semantic diff kind,
and code patterns). Always **signal-only** — results are attached to the run record but never block
publish. The `aggregateStaticSignal` entry point in `aggregate.ts` calls each extractor in parallel;
any single extractor that throws is fail-open (error recorded in `sig.skipped`, the rest continue).

## Extractors

| Extractor | Binary / lib | Language-agnostic? |
|---|---|---|
| `symbols.ts` | `web-tree-sitter` + `tree-sitter-wasms` (npm) | No — needs grammar + query per language |
| `relations.ts` | same as symbols | No — needs grammar per language |
| `complexity.ts` | `lizard` (pip) | Yes — Lizard supports 30+ languages out of the box |
| `semantic-diff.ts` | `difft` (release binary) | Yes — difftastic is self-contained per language |
| `patterns.ts` | `sg` / ast-grep (release binary) | Partial — ast-grep rules are per-language; regex fallback is generic |

## Adding a language

1. **`languages.ts`** — add the language id to `LanguageId`, to `SUPPORTED_LANGUAGES`, and map its
   file extensions in `EXT_TO_LANGUAGE`. This is the SINGLE registry entry; nothing else needs to
   know about the new language until you add support in each extractor below.

2. **`symbols.ts` + `relations.ts`** — add the grammar wasm. `tree-sitter-wasms` ships grammars for
   most languages; confirm the wasm name (e.g. `tree-sitter-ruby.wasm`) is present in the installed
   package, then add an entry to the `GRAMMAR_FILE` map in `symbols.ts` (e.g. `ruby: "tree-sitter-ruby.wasm"`).
   The parser is loaded lazily from that map — no other function needs to change. Add the corresponding
   Tree-sitter query file at `queries/<lang>.scm` (symbols extractor reads it; relations extractor reuses
   the same grammar).

3. **`patterns.ts`** — to enable structured ast-grep rules for the new language, add it to the
   `AST_GREP_LANGUAGES` set and add per-pattern entries to the `AST_GREP_RULES` map. If no ast-grep
   rules are needed, rely on the built-in regex fallback: any language absent from `AST_GREP_LANGUAGES`
   is automatically routed to the regex engine via `patternsForLanguage`, which returns `"regex"`. The
   regex fallback captures `TODO/FIXME/HACK` and long-function heuristics generically and requires no
   per-language work.

4. **`complexity.ts` + `semantic-diff.ts`** — no changes needed. Lizard and difftastic detect the
   language automatically from the file extension; there is no per-language configuration here.

## Binary installation (Docker)

`lizard`, `difft`, and `sg` are installed in the orchestrator image (`Dockerfile`). The
`web-tree-sitter` and `tree-sitter-wasms` packages come from `npm install` (already in
`package.json`). When bumping binary versions, update the versions in `Dockerfile` and re-verify
the release asset URLs with `curl -I` before committing (the CI does not run `docker build`).

## Design constraints

- **Project-agnostic**: no reference to any watched-app name or config path inside this directory.
- **Fail-open**: every extractor is wrapped by the guard in `aggregate.ts`; a missing binary or
  parse error adds to `sig.skipped` and never surfaces as a pipeline error.
- **Signal-only**: `aggregateStaticSignal` is wired into `defaultPipelineDeps` in `pipeline.ts`;
  the result feeds the run record but `decideCoverage` never reads it — the coverage gate uses
  V8/Istanbul line coverage, not static signals.

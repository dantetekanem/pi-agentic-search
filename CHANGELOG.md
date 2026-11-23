# Changelog

## Unreleased

### Added

- Scan anchors report `status` (`added` or `modified` against the base revision), `whitespaceOnly` (changed lines that `git diff -w` drops, from one extra Git call per scan) and `signatureChanged` (the parameter list differs from the base definition's). Adapter definitions carry their parameter list as `signature`.
- Unresolved edges carry a `reason` (`operator`, `unknown-receiver`, `dynamic` or `no-definition`), and collect and scan coverage report `unresolvedByReason`. The scan recap and collect coverage text show the counts.
- Scan anchors that run when their file loads carry `loadTime: true`: top-level statements, declarations, constants and objects, and Ruby class-body calls other than `scope` and `define_method`.
- Guards: the Ruby and TypeScript adapters report the conditions that dominate a line (`guardsAt`) and a call site (`CallSite.guards`), as written, with the branch `then`, `else` or `after-return`. Scan anchors list `guards` for their changed lines, call edges carry their call site's guards, and the anchor section's text shows them.
- Ruby `enqueues` edges: `Job.perform_later`, `Job.set(...).perform_later` and Sidekiq's `perform_async`/`perform_in`/`perform_at`/`perform_bulk` resolve to `Job#perform`, and `Mailer.action(...).deliver_later` to the mailer action; the target is expanded like a call. `SparsityNode.effects` and scan anchors' `effects` (for changed lines) list write, enqueue and cache calls with their text, read before common methods are dropped.
- Scan anchors report `callerCount: { total, shown, complete }`: the production call sites found, how many `callers` lists, and whether that is all of them. `scan --callers all` lists every call site, several per file. With a Ruby index, names too common to search by name (`call`, `perform`…) are filtered by receiver type instead of skipped, and enqueues such as `Job.perform_later` are call sites of `Job#perform` (index format 4). Caller records add `resolution`, `guards` and `enqueue`; `called_by` edges carry their call site's `guards` and are `exact`, with `via`, when the index's receiver type dispatches to the anchor or the TypeScript checker resolved the call to it. They were always `static_candidate`.
- Entry points: with a Ruby index, nodes and scan anchors carry `entry: { kind, exact }`: `job` for the `perform` of a class whose ancestors include `ApplicationJob`, `ActiveJob::Base` or a Sidekiq job mixin, `controller` for a public method of a class under `ApplicationController` or `ActionController::Base`/`API`. `exact` is true for jobs and for actions that a route in `config/routes.rb` names. The routes are read from its syntax tree (`readRoutes`: verbs, paths, controller actions and URL helper names), and statements the reader skips are named in a coverage note. Ruby definitions record `visibility` for private and protected methods (index format 5).
- A tests search for a Rails controller action or job (`OrdersController#create`, `ReceiptJob`, or a method name with `path` set to its file) also returns the tests that drive it in `details.entryTests` and a text section, each labelled with how it was found: `path` (a test file named after the class), `class` (a test class or `describe` names it), `route` (a request through a URL helper or path of a route to the action, when `config/routes.rb` parses), `enqueue` or `perform` (for a job).
- `scan --tests all` lists every test definition that references an anchor in `testDefinitions`: the anchors and lines it references, whether the diff changed it, and the setup blocks that run before it with their lines (Ruby `setup`, `before` and `def setup`; JS/TS `beforeEach`, `beforeAll`, `before` and `setup`). Each is expanded one hop, so its calls are `calls` edges from its node, and the pack gets a `tests` section. With a Ruby index, names too common to search are filtered by receiver type. Adapters report `setupBlocks`.
- `collect --cache-dir <path>` and `scan --cache-dir <path>` keep the Ruby index in that directory between runs instead of a temporary one, so a later run at the same commit reuses it.
- Nodes, scan anchors and grouped test entries carry `semanticFingerprint` beside `fingerprint`: the definition's syntax tree (Prism's for Ruby, the compiler's for JS/TS) hashed without comments or layout, so it holds across comment edits and re-indentation. Adapters report `semanticFingerprint`.
- Entry points say how requests reach them: a routed action's `routes` (`{ verbs, path, file, line, text }` for each route of `config/routes.rb` that names it), and `exceptionsApp` for the action `config.exceptions_app` names in `config/application.rb` (`readExceptionsApps`). JavaScript and TypeScript definitions a package exposes carry `entry: { kind, exact: true, doors }`: `command` (a `bin` file's statements), `extension` (the default export of a `pi.extensions` module) and `export` (what `main`, `module` or `exports` export, through re-exports), each door a package.json line.
- Rails view templates are definitions of kind `template`, the whole file, and changed ones are anchors. A template that calls a helper or a model method in its Ruby is a caller of it, by name, and `exact` for a helper called with no receiver. A template's callers are the render calls that name it (`exact`, via `render`, with the written name in `name`), object renders named after its model, and the action that renders it by convention (`exact`, via `convention`, `convention: true`).
- A script with no file ending is read in the language its shebang names (Ruby, or Node, `tsx`, `ts-node`, `bun` and `deno` as JavaScript): its definitions are anchors and nodes, the Ruby index reads it (index format 6), and searches for callers and tests include it. A shell script stays plain text. A script's top-level statements are definitions with `entry: { kind: "command" }`, run from the command line, and callers of what they call. With a Ruby index, a call to `new` is also a call site of the class's `initialize` (index format 8).
- A JavaScript or TypeScript caller whose call sits in a function that is the value of an object literal's property, or whose value is the name itself, gives the property's key in its caller record's `key` (`review.prepare`), and the anchor's text shows it. The TypeScript adapter reports it as `wayIn`.
- A map of handlers by name is a way in. A caller record whose call site is in one of its handlers, or names the handler's value, has `entry: { kind: "handler", exact, doors }`, the door titled by the key at the line of the property; an anchor registered by name as a handler's value carries the entry when it has none. `exact` when the same file reads the map by a key it is given; not exact for a map of functions written in place under at least one quoted key that is no name. Other caller records carry their caller's own entry.
- A listener is a way in: `entry: { kind: "listener", exact, doors }`, the door titled by the event at the line of the call, for a function registered with `on`, `once`, `addListener`, `prependListener`, `prependOnceListener` or `addEventListener` and a literal event, Electron's `ipcMain.handle` and Tauri's `listen`. Exact on `process`, `window`, `document`, a bare `addEventListener` and what Electron's or Tauri's modules give; not exact on an emitter the module holds or imports; none on a parameter, local or member, such as a stream's `data` in the function that opened it.
- A route a Node app registers is a way in: `entry: { kind: "route", exact, routes }`, with `routes` shaped as a Rails action's (`{ verbs, path, file, line, text }`), for `R.get('/path', fn)` and the other verbs, `all`, and Hono's `R.on(verbs, '/path', fn)`. Exact when an Express, Hono, Fastify, Koa router or Elysia call made R, or a parameter has one of their types; not exact when R is only named like an app or a router.

### Changed

- Scan file kinds add `migration`, `config`, `dependency` and `schema`. Lockfiles and `db/schema.rb`-style dumps were `generated`; `Gemfile`, `package.json` and YAML configuration were `other`; migrations and Ruby or JS/TS configuration were `code`, and they are still anchored. Metrics and the manifest count the new kinds.
- Ruby test blocks inside `RSpec.describe` are parsed as test definitions of kind `test`, as blocks inside a bare `describe` were, so their calls are read. They came from the line-pattern engine, with kinds such as `it` and no calls.

### Fixed

- A call on a line that writes its name first inside a string is a caller: `'review.prepare': ({ id }) => reviews.prepare(id)` in a map of handlers, `bus.on('sync', () => sync())`. The by-name search dropped a line when the first place it wrote the name was in quotes, so such a caller was missed and `callerCount` could read complete without it. A Ruby line is dropped only when every place it writes the name as a word is in a string; a JavaScript or TypeScript line is checked against its syntax tree alone, so a call inside a template's `${}` counts too.
- A call written as an assignment or an export (`const host = await startHost({`, `export const y = foo()`, Ruby `x = foo(1)`) is a caller. The by-name search dropped every line that began with `const`, `export`, `def`, `import`…, so such callers were missed and `callerCount` could read `{ total: 0, complete: true }`. A hit is now dropped only when its line declares, imports or re-exports the searched name itself.
- Test searches keep to the anchor's language. Ripgrep's test globs override its file types, so a Ruby anchor could list a JavaScript test that names the same method (and the reverse), and a scan where both languages share a name could fail with `Cannot read properties of undefined (reading 'getLineStarts')`.
- `scan` of a committed range no longer fails with `Cannot read properties of undefined (reading 'trim')` when the checkout's copy of a changed file is longer than the range head's. Searches read changed files at the range head, so a caller inside one is reported at the head's line, and a hit whose line text differs from the content the scan reads is dropped.

## 0.7.1 (2026-10-26)

### Fixed

- Clarify the skill's package-relative `.mjs` fallback when the command is not on `PATH`, including missing-build handling without compiling or installing software.

## 0.7.0 (2026-10-26)

### Added

- Standalone `agentic-search search|collect|scan` CLI with text or JSON output, per-command help and a portable skill. Pi tools and the CLI share the search and context implementation.
- Compiled CLI packaging with optional Pi peer dependencies, so other harnesses can use the command without installing Pi.

### Changed

- Document Code Mode setup, tool discovery, activation limits and text return values in the README, tool descriptions and built-in agent guidance.

## 0.5.2 (unreleased draft; superseded by 0.7.0)

### Added

- Every `sparsity_scan` anchor and the `sparsity_collect` anchor now end with `vicinity above` and `vicinity below`: the same number of file lines as `vicinity_check` outside the definition, with the count of lines that remain before and after. A new definition is read in the company of its neighbors instead of alone.
- Each production caller in a `sparsity_scan` anchor section shows three lines around the call site, the calling line marked `>`.
- Files without a parser (any language other than Ruby and JS/TS) keep their `file:` hunk sections and now carry `vicinity_check` head-file lines around each hunk, plus a note that callers, tests and sibling definitions must be read by hand. Deleted-only hunks take their vicinity from the old file.

### Changed

- `AnchorRecord` gains `vicinity`; caller records gain `context`; `FileHunkRecord` hunks gain `vicinity` and the record gains `parsed`. `SparsityNode.vicinity` is optional and set on anchors only.

## 0.5.1 (2026-09-15)

### Changed

- Rewrite the README around reducing agent searches and file reads, with usage examples and the current tools' limits.

## 0.5.0 (unreleased)

### Changed

- Diff indexing ignores a whole-repository `root: "."` override and keeps the nearest component root per changed file. Ruby discovery stops at the 8,001st path when a root exceeds the 8,000-file cap instead of enumerating the repository.
- Non-code and generated files now get changed-hunk sections with `+|` and `-|`, so schema, JSON and YAML changes are review evidence in the pack rather than collector work.
- Added-file class/module wrappers are omitted when child definitions carry the behavior. Each changed test file keeps two representative anchors and groups the rest into one file-level section. The manifest exposes production anchors, test anchors/groups, non-code hunks and closed gaps as `REVIEW INPUTS`.

### Fixed

- Call expansion ranks internal destinations across the whole definition. External calls, callback parameters and repeated destinations no longer consume the expansion allowance. Callback parameters no longer create false self-cycles.
- `sparsity_collect` reports wall time including initial parser, index and compiler setup. Its header groups unexpanded calls by cap or budget reason, and callers respect the total node cap.
- Ruby traces follow constructors, declared scope chains and symbol-to-proc calls through local `map`/filter element types. Unknown callbacks, missing constructors and dynamic scope bodies remain explicit gaps. Collection inference respects reassignment and block shadowing; the Ruby index cache version changes with these facts.
- Directory and partial-path searches expand from ranked matching files rather than walking every source file in the directory. The selected seeds and omissions are recorded. Directory searches no longer widen into the owning repository merely because the intent is `references`.
- Search text and the TUI group repeated coverage reasons with counts and bounded examples. Detailed reasons, roots and relationships remain available in the tool result.

## 0.4.0 (unreleased)

### Added

- `sparsity_scan`: one call per diff (`base..head`, `base...head`, a commit or `worktree`) that returns a ranked context pack: manifest, one section per changed definition with `+|` and `-|` marks, resolved calls with `[resolution, how]` labels, callers, tests by name, definitions removed with surviving callers, depth tiers and a recap of gaps; sections over the inline budget spill to `pack.md` with line ranges.
- `sparsity_collect`: bounded call context for one `path:line` with the same labels, callers, cycles and frontier.
- Ruby adapter on `@ruby/prism` with a per-component index cached by git tree hash; TypeScript and JavaScript adapter on the compiler API with one program per tsconfig; checker-resolved and inferred edges never share a label with name-only guesses.
- Boundary ranking of anchors and callers, per-run `metrics.json`, a rolling `sparsity/metrics.jsonl` log and the `/agentic-search-stats` command.
- Changed files are read at the range head when the checkout sits on another commit; the manifest says so in a `revision:` line.

## 0.3.0 (2026-09-08)

This version covers the search improvement stack (#1 through #9) and the Ruby lookup repair (#10).

### Added

- Search intents for definitions, references, tests, files and automatic navigation, with declaration evidence and bounded context ranking.
- Project-aware JavaScript and TypeScript resolution for configuration aliases, package exports/imports, workspace links and renamed re-exports, using the extension's trusted TypeScript compiler.
- Shared, bounded related-file traversal for JavaScript, TypeScript and Ruby, including conventional and literal-configured Ruby autoload roots.
- Reproducible synthetic benchmarks, a frozen public corpus, five feature ablations and an opt-in model navigation probe with public-source checks and a shared spending limit.

### Changed

- Retrieve candidates independently of display limits; existing exact-file searches without expansion avoid repository listings.
- Search targets, aliases and package entries before widening, with bounded concurrency, request deadlines and cancellation cleanup.
- Report evidence tiers and complete, partial or failed coverage instead of confidence-like labels.
- Use npm as the sole supported package workflow; remove the alternate pnpm lockfile and workspace configuration.

### Fixed

- Recover matches beyond the former first-200 cutoff and search every candidate for ambiguous path hints.
- Preserve native ripgrep regex behavior and smart-case matching, including renamed-symbol searches and the evaluation oracle's explicit `case_sensitive: false` handling.
- Keep counts and retained results intact when an alias rescan fails; deduplicate overlapping searches.
- Resolve Ruby mixins through actual lexical frames: `class Admin::User` does not invent `Admin` as an enclosing lexical scope.

### Known limitations

- The public corpus still contains Zod caller-ranking and constructor-span misses. Graph resolution is static and can report partial coverage; a useful result does not imply complete traversal.
- Curated measurements show retrieval and navigation gains, not universal speed, accuracy or token savings. See the [evaluation PR](https://github.com/dantetekanem/pi-agentic-search/pull/8) for results and limits.

# Runtime access

`pi-agentic-search` runs locally in the Pi process. This document describes the access used by the published package; it does not add runtime capabilities.

## Process execution

The extension invokes the locally installed `rg` executable (ripgrep) through Node's `spawn` API. Search terms and paths are passed as arguments, not through a shell. One request deadline covers child processes and is forwarded to related traversal. Cancellation or a retrieval budget terminates the current child and reports incomplete coverage; process exit and signal information remain in the result details.

## Filesystem access

The extension reads files beneath the supplied working directory (`cwd`) to search and rank results. When related-import expansion is requested, it also reads bounded source prefixes, import targets, and package manifests needed to resolve related imports. Both language adapters use a request-local rg file inventory and canonical text caches; cancellation is checked between traversal and resolution operations. Ruby constant indexing also reads literal configured autoload roots, which may be outside `cwd`. Ruby configuration and dynamic mixin expressions are not executed. Resolved package imports can be outside `cwd` when the local module resolver points there. With a ranking context supplied, the extension also reads up to 64 KiB from each of eight candidate files, retaining at most 512 bytes of neighboring context per retained match. Those candidates can be outside `cwd` when an explicit root or related import points there.

JS/TS resolution lazily loads the extension's installed TypeScript dependency. It reads the nearest `tsconfig.json`/`jsconfig.json`, inherited configurations, and package manifests through the shared bounded filesystem cache. Configuration may refer outside `cwd`. It does not load repository-provided compilers, compiler plugins, or bundler configuration code, and does not create a typechecking program. An installed project compiler's version is read as manifest data; version differences are reported. The compiler's synchronous host callbacks use settled request-local facts, with asynchronous reads between passes. Pass/metadata exhaustion and cancellation produce explicit skipped work. An individual compiler pass or initial dependency load is not preemptible.

When a result exceeds Pi's output limits, the extension may write the complete result beneath the directory returned by Node's `os.tmpdir()`, using `pi-agentic-search-*/output.txt`, and reports the actual path in the truncated response. It does not write there for untruncated output.

## Network access

The extension makes no direct network requests. Package installation, Pi host behavior, and the `rg` executable are outside this extension's direct network behavior.

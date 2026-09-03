# Runtime access

`pi-agentic-search` runs locally in the Pi process. This document describes the access used by the published package; it does not add runtime capabilities.

## Process execution

The extension invokes the locally installed `rg` executable (ripgrep) as a subprocess via Node's `spawn` and `execFile` APIs. Search terms and paths are passed as arguments, not through a shell.

## Filesystem access

The extension reads files beneath the supplied working directory (`cwd`) to search and rank results. When related-import expansion is requested, it also reads source files, import targets, and package manifests needed to resolve related imports. Resolved package imports can be outside `cwd` when the local module resolver points there.

When a result exceeds Pi's output limits, the extension may write the complete result beneath the directory returned by Node's `os.tmpdir()`, using `pi-agentic-search-*/output.txt`, and reports the actual path in the truncated response. It does not write there for untruncated output.

## Network access

The extension makes no direct network requests. Package installation, Pi host behavior, and the `rg` executable are outside this extension's direct network behavior.

<!-- source: .claude/references/devenv-full.md lines 16076-16119 -->

# MCP Server

`devenv mcp` launches a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that exposes devenv functionality to AI assistants.

## Usage

### Stdio mode (default)

```sh
$ devenv mcp
```

The server communicates over stdin/stdout. This is the mode used when an AI tool spawns devenv as a subprocess.

### HTTP mode

```sh
$ devenv mcp --http
$ devenv mcp --http 9090
```

Starts the MCP server as an HTTP service. The default port is 8080.

## Available tools

The MCP server provides:

* **search\_packages** — search for packages in the nixpkgs input.
* **search\_options** — search for devenv configuration options.

## Integration with Claude Code

See [Claude Code integration](/integrations/claude-code/) for instructions on configuring Claude Code to use the devenv MCP server automatically.

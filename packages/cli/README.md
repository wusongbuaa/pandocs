# @pandocs/cli

The `pandocs` command line: read and change a Pandocs site from a terminal, and keep a space as files on disk. It is a single binary written in Go, and npm installs the one for your system, for macOS, Linux and Windows on x64 and arm64.

```bash
npm install -g @pandocs/cli
pandocs login --server https://docs.example.com   # opens your browser to sign in; --token to paste one instead
pandocs sync handbook                             # into ./handbook
cd handbook
$EDITOR getting-started.md
pandocs commit -m "Fix the first step"
```

Or without installing it: `npx @pandocs/cli spaces`.

For an MCP client that only speaks stdio:

```json
{
  "mcpServers": {
    "pandocs": {
      "command": "npx",
      "args": ["-y", "@pandocs/cli", "mcp"],
      "env": { "PANDOCS_URL": "https://docs.example.com", "PANDOCS_TOKEN": "pd_your_token" }
    }
  }
}
```

`pandocs help` lists the rest. See [Files and agents](https://github.com/wusongbuaa/pandocs/blob/main/docs/files-and-agents.md#the-command-line) for how syncing and committing work.

The binary comes from a package of its own for each system, such as `@pandocs/cli-linux-x64`, which npm picks by itself. Installing with `--omit=optional` leaves it out. The same binaries are on the [releases page](https://github.com/wusongbuaa/pandocs/releases), with checksums and signed provenance.

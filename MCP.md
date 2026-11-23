# bundeswahl-mcp

An [MCP](https://modelcontextprotocol.io/) server for the open data of
[Die Bundeswahlleiterin](https://www.bundeswahlleiterin.de) on the Bundestagswahl of 23 February
2025: the results for the Bund, the 16 Länder and the 299 Wahlkreise, the Wahlkreise and their
structural data, and the parties, as tools for AI agents. Read-only, no API key, Datenlizenz
Deutschland – Namensnennung 2.0.

It is the MCP side of [bundeswahlleiterin-cli](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeswahlleiterin-mcp
```

This installs the **`bundeswahl-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/bundeswahlleiterin-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add bundeswahl -- bundeswahl-mcp
# or with the image:
claude mcp add bundeswahl -- docker run -i --rm ghcr.io/maschinenlesbar-org/bundeswahlleiterin-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "bundeswahl": { "command": "bundeswahl-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "bundeswahl": { "type": "stdio", "command": "bundeswahl-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
bundeswahl-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http bundeswahl http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/bundeswahlleiterin-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/releases) instead of
`latest`: `…/bundeswahlleiterin-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/bundeswahlleiterin-mcp:<version> --repo maschinenlesbar-org/bundeswahlleiterin-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getElectionResult` | An area's result: turnout, valid and invalid votes, every party's votes and share with the change since 2021; in a Wahlkreis, the most first votes and who was elected. Ambiguous names list the candidates. |
| `findWahlkreise` | Wahlkreise by name, Land or number, a page at a time. |
| `getStructureData` | A Wahlkreis' structural data as published, with the footnote that says which values are city-wide. |
| `listParties` | The parties and groups that stood, short and full names. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.bundeswahlleiterin.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429, and stops a tool call after its deadline.
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/LICENSING.md)).
Data: Die Bundeswahlleiterin publishes it under the Datenlizenz Deutschland – Namensnennung 2.0:
name the source ("Quelle: Die Bundeswahlleiterin, Wiesbaden 2025") and say so if you changed the
data ([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field.

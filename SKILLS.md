# bundeswahlleiterin-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
the **German federal election** (Bundestagswahl 2025), all powered by the
**[bundeswahl](README.md)** CLI over the Bundeswahlleiterin open data.

Each skill teaches Claude how to drive the `bundeswahl` CLI to answer a specific,
real-world question — "who won the 2025 Bundestagswahl?", "SPD's second-vote share
in Bavaria?", "which constituencies are in a Land?" — and to report the answer with
a source citation. They encode the parts that are easy to get wrong (Erststimme vs
Zweitstimme, the System-Gruppe totals, the long/tidy result shape, the attribution
requirement) so Claude doesn't rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **bundeswahl-results** | The official result — first/second votes by Bund, Land or Wahlkreis, filtered by party. | "who won the 2025 Bundestagswahl?", "SPD second-vote share", "which party won the direct mandate in Kiel?", "how high was turnout?" |
| **bundeswahl-reference** | The reference data — parties, the 299 constituencies (by Land), and structural data per Wahlkreis. | "which parties stood?", "list the Wahlkreise in Bavaria", "structural data for a constituency" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `bundeswahl` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/bundeswahlleiterin-cli   # installs the `bundeswahl` bin
  ```
- **No API key** — the Bundeswahlleiterin open data is public.

## Installation

### Plugin marketplace (recommended)

The skills are published as the `bundeswahl` plugin in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins),
which lists the plugins for all maschinenlesbar.org CLIs. Installation is two
commands inside Claude Code:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install bundeswahl@maschinenlesbar
```

The first command registers the marketplace (once, for all maschinenlesbar.org
plugins); the second installs the `bundeswahl` plugin, which bundles both skills.
Update later with `/plugin marketplace update maschinenlesbar`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/bundeswahl-results/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> What was the second-vote result of the 2025 Bundestagswahl, top five parties?

> Which party won the most constituencies in Bavaria?

> How high was turnout nationally?

You can also invoke a skill explicitly with its slash command, e.g. `/bundeswahl-results`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`bundeswahl` subcommands to call and how to interpret the JSON. The skills encode the
non-obvious parts of this data, for example:

- **Erststimme vs Zweitstimme** — the headline "result" is the second vote (`--vote 2`,
  party list); the first vote decides the direct mandate;
- **System-Gruppe rows are totals**, not parties (Wahlberechtigte, Wählende, Gültige,
  …) — filter with `--group-type Partei` unless you want turnout;
- **the result is long/tidy** — one row per area × group × ballot, with `anzahl` (int)
  and `prozent` (number), and `null` for empty cells (parties without a candidate or
  list in that area), which a `jq` sort must drop first;
- **`gewaehlt` is not the Erststimme winner** — in 23 Wahlkreise the winner's seat was
  not covered by the party's Zweitstimmen and `gewaehlt` is `–`;
- **`--area` numbers and names are ambiguous** — Land 14 and Wahlkreis 014 both match
  `14`, and `Sachsen` also matches Niedersachsen — so pair it with `--area-type`;
- **Wahlkreis numbers differ across files** (`005` vs `5`) — the CLI normalises them;
- **Strukturdaten values are German-format strings**, and for cities split into several
  Wahlkreise most columns hold the city-wide value (see `Fußnoten`);
- **attribution is required** — the data is Datenlizenz Deutschland – Namensnennung 2.0,
  so cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.

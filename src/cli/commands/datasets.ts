// The Bundeswahlleiterin command group: one command per open-data dataset. Each
// fetches and parses its CSV and prints typed JSON. `results` filters client-side
// by area, party and ballot; `wahlkreise`/`structure` take a small filter each.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import type { AreaType, ResultsQuery, Vote } from "../../client/types.js";
import { action, parseTextArg, renderJson } from "../shared.js";

const AREA_TYPES: readonly AreaType[] = ["Bund", "Land", "Wahlkreis"];

/** commander value-parser for --area-type: one of Bund | Land | Wahlkreis (case-insensitive). */
function parseAreaType(value: string): AreaType {
  const match = AREA_TYPES.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  if (!match) throw new InvalidArgumentError(`Expected one of: ${AREA_TYPES.join(", ")}.`);
  return match;
}

/** commander value-parser for --vote: 1/erst → 1, 2/zweit → 2 (Erst-/Zweitstimme). */
function parseVote(value: string): Vote {
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "erst" || v === "erststimme") return 1;
  if (v === "2" || v === "zweit" || v === "zweitstimme") return 2;
  throw new InvalidArgumentError("Expected 1 (Erststimme) or 2 (Zweitstimme).");
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("results")
    .description("Bundestagswahl 2025 results (by area, party and ballot)")
    .option("--area-type <level>", "restrict to Bund | Land | Wahlkreis", parseAreaType)
    .option("--area <nr-or-name>", "an area by number (leading zeros ignored) or name substring, e.g. 005 or Kiel; Land and Wahlkreis numbers overlap, so pair with --area-type", parseTextArg)
    .option("--party <name>", "a party/group by name substring, e.g. SPD, GRÜNE", parseTextArg)
    .option("--vote <1|2>", "restrict to 1 (Erststimme) or 2 (Zweitstimme)", parseVote)
    .option("--group-type <type>", "restrict to a Gruppenart, e.g. Partei, System-Gruppe", parseTextArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const q: ResultsQuery = {};
        if (typeof opts["areaType"] === "string") q.areaType = opts["areaType"] as AreaType;
        if (typeof opts["area"] === "string") q.area = opts["area"];
        if (typeof opts["party"] === "string") q.party = opts["party"];
        if (typeof opts["vote"] === "number") q.vote = opts["vote"] as Vote;
        if (typeof opts["groupType"] === "string") q.groupType = opts["groupType"];
        renderJson(deps, global, await client.results(q));
      }),
    );

  program
    .command("parties")
    .description("The parties / groups reference list (btw25_parteien)")
    .action(action(deps, async ({ client, global }) => renderJson(deps, global, await client.parties())));

  program
    .command("wahlkreise")
    .description("The 299 constituencies (Wahlkreise), optionally filtered by Land")
    .option("--land <land>", "only Wahlkreise in this Land (name, abbreviation or number)", parseTextArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const land = typeof opts["land"] === "string" ? opts["land"] : undefined;
        renderJson(deps, global, await client.wahlkreise(land !== undefined ? { land } : {}));
      }),
    );

  program
    .command("structure")
    .description(
      "Structural data (Strukturdaten) for the 299 Wahlkreise; the official " +
        "Land/Bund summary rows are excluded unless --include-aggregates is passed",
    )
    .option("--wahlkreis <nr-or-name>", "one Wahlkreis by number (leading zeros ignored) or name substring", parseTextArg)
    .option(
      "--include-aggregates",
      'also return the official summary rows: 16 "Land insgesamt" (Wahlkreis-Nr. 901-916) ' +
        'and the national "Insgesamt" (999). Use these for Land/Bund figures rather than ' +
        "summing Wahlkreise, which double-counts the city states",
    )
    .action(
      action(deps, async ({ client, global, opts }) => {
        const wahlkreis = typeof opts["wahlkreis"] === "string" ? opts["wahlkreis"] : undefined;
        renderJson(
          deps,
          global,
          await client.structure({
            ...(wahlkreis !== undefined ? { wahlkreis } : {}),
            ...(opts["includeAggregates"] === true ? { includeAggregates: true } : {}),
          }),
        );
      }),
    );
}

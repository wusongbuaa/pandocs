#!/usr/bin/env node
/**
 * The licenses of what ends up inside what is released. The server and the web app are bundled into a few files, which
 * leaves out the notices these licenses say have to go along, so they go along in one file instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu;

const textsIn = directory =>
  (existsSync(directory) ? readdirSync(directory) : [])
    .filter(name => LICENSE_FILE.test(name))
    .sort()
    .map(name => readFileSync(join(directory, name), "utf8").trim());

const listing = args =>
  JSON.parse(
    execFileSync("pnpm", [...args, "licenses", "list", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  );
// The web app is built into static files, so everything in it is a development dependency of that package.
const packages = [
  ...new Map(
    [listing(["--prod"]), listing(["--filter", "@pandocs/web"])].flatMap(listed =>
      Object.entries(listed).flatMap(([license, items]) =>
        items.flatMap(item =>
          item.versions.map((version, at) => [
            `${item.name}@${version}`,
            { name: item.name, version, license, directory: item.paths[at] }
          ])
        )
      )
    )
  ).values()
];
packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

/**
 * What a package carries built in, with the license comments stripped and no license file of its own, so its notice
 * has to be added here. Look again when one of these is updated, or a package says it ships another project inside.
 */
const CARRIED = new Map([
  // Apache-2.0, the same text as this project's own LICENSE.
  [
    "unpdf",
    {
      project: "PDF.js",
      source: "https://github.com/mozilla/pdf.js",
      copyright: "Copyright 2012 Mozilla Foundation",
      license: "Apache-2.0",
      text: "LICENSE"
    }
  ]
]);

const parts = ["The Pandocs server and web app include the following packages.\n"];
for (const { name, version, license, directory } of packages) {
  // Our own packages are covered by this project's license.
  if (name.startsWith("@pandocs/")) continue;
  const texts = textsIn(directory);
  parts.push(
    `${"-".repeat(72)}\n${name} ${version}\nLicense: ${license}\n${texts.length > 0 ? `\n${texts.join("\n\n")}\n` : ""}`
  );
  const carried = CARRIED.get(name);
  if (carried) {
    parts.push(
      `${"-".repeat(72)}\n${carried.project}, built into ${name} ${version} (${carried.source})\nLicense: ${carried.license}\n\n${carried.copyright}\n\n${readFileSync(carried.text, "utf8").trim()}\n`
    );
  }
}
// Copies kept in this repository rather than installed, which NOTICE describes. Their notices go along all the same.
const VENDOR = "packages/web/vendor";
for (const copy of readdirSync(VENDOR).sort()) {
  const texts = textsIn(join(VENDOR, copy));
  if (texts.length > 0)
    parts.push(
      `${"-".repeat(72)}\n${VENDOR}/${copy}, a copy kept in the Pandocs repository\n\n${texts.join("\n\n")}\n`
    );
}
process.stdout.write(`${parts.join("\n")}\n`);

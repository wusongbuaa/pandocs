#!/usr/bin/env node
/**
 * What has to agree for a release: the version everywhere it is written, and what the changelog says about it.
 *
 *   node scripts/release.mjs versions                   Where each version stands
 *   node scripts/release.mjs set 0.2.0 [--date Y-M-D]   Writes it everywhere, and gives the changelog's unreleased part this heading
 *   node scripts/release.mjs check 0.2.0 [--rehearsal]  Fails unless everything is ready for this version
 *   node scripts/release.mjs notes 0.2.0 [--rehearsal]  What the changelog says about it
 *
 * In a rehearsal the version does not have to be in the changelog yet, so what is unreleased stands in for it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const CHANGELOG = "CHANGELOG.md";
const UNRELEASED = "## Unreleased";
const VALID = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const read = path => readFileSync(join(root, path), "utf8");
const write = (path, text) => writeFileSync(join(root, path), text);

const packageFiles = () => [
  "package.json",
  ...readdirSync(join(root, "packages")).map(name => `packages/${name}/package.json`).filter(path => existsSync(join(root, path)))
];

/** Each place holds the version once, the first match of its pattern, which is all these need to be told apart. */
const places = () => [
  ...packageFiles().map(path => ({ path, pattern: /^ {2}"version": "([^"]+)"/mu })),
  { path: "deploy/helm/pandocs/Chart.yaml", pattern: /^version: (\S+)$/mu },
  { path: "deploy/helm/pandocs/Chart.yaml", pattern: /^appVersion: "([^"]+)"$/mu },
  { path: "docs/api/openapi.yaml", pattern: /^ {2}version: (\S+)$/mu }
];

const found = () => places().map(({ path, pattern }) => ({ path, version: pattern.exec(read(path))?.[1] ?? "(not found)" }));

/** The lines under a heading, up to the next one at that level. */
function sectionUnder(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex(line => line === heading || line.startsWith(`${heading} - `));
  if (start < 0) return null;
  const end = lines.findIndex((line, at) => at > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

const notesFor = (version, rehearsal) => {
  const text = read(CHANGELOG);
  return sectionUnder(text, `## ${version}`) ?? (rehearsal ? sectionUnder(text, UNRELEASED) : null);
};

function problemsWith(version, rehearsal) {
  const problems = [];
  if (!VALID.test(version)) problems.push(`${version} is not a version such as 0.2.0 or 0.2.0-rc.1`);
  for (const place of found()) if (place.version !== version) problems.push(`${place.path} says ${place.version}`);
  if (!notesFor(version, rehearsal)) problems.push(`${CHANGELOG} says nothing about ${version}${rehearsal ? " and has nothing unreleased" : ""}`);
  for (const file of ["LICENSE", "NOTICE"]) if (!existsSync(join(root, file))) problems.push(`${file} is missing`);
  return problems;
}

function set(version, date) {
  if (!VALID.test(version)) throw new Error(`${version} is not a version such as 0.2.0 or 0.2.0-rc.1`);
  const changelog = read(CHANGELOG);
  if (sectionUnder(changelog, `## ${version}`) !== null) throw new Error(`${CHANGELOG} already has ${version}`);
  if (!sectionUnder(changelog, UNRELEASED)) throw new Error(`${CHANGELOG} has nothing unreleased to give this heading to`);
  for (const { path, pattern } of places()) {
    const text = read(path);
    const match = pattern.exec(text);
    if (!match) throw new Error(`${path} has no version where it was expected`);
    write(path, text.replace(pattern, whole => whole.replace(match[1], version)));
  }
  write(CHANGELOG, changelog.replace(UNRELEASED, `${UNRELEASED}\n\n## ${version} - ${date}`));
}

function main([command, version, ...rest]) {
  const rehearsal = rest.includes("--rehearsal");
  switch (command) {
    case "versions":
      for (const place of found()) console.log(`${place.version}\t${place.path}`);
      return 0;
    case "set": {
      const at = rest.indexOf("--date");
      set(version, at >= 0 ? rest[at + 1] : new Date().toISOString().slice(0, 10));
      console.log(`Set to ${version}. Run scripts/generate-sdks.sh to see nothing else needs to change, and commit.`);
      return 0;
    }
    case "check": {
      const problems = problemsWith(version, rehearsal);
      for (const problem of problems) console.error(problem);
      if (problems.length === 0) console.log(`Everything says ${version}.`);
      return problems.length === 0 ? 0 : 1;
    }
    case "notes": {
      const notes = notesFor(version, rehearsal);
      if (!notes) {
        console.error(`${CHANGELOG} says nothing about ${version}`);
        return 1;
      }
      console.log(notes);
      return 0;
    }
    default:
      console.error("Usage: release.mjs versions | set <version> [--date YYYY-MM-DD] | check <version> [--rehearsal] | notes <version> [--rehearsal]");
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

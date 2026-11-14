#!/usr/bin/env node
/**
 * The command line on npm: @pandocs/cli, and a package for each system with its binary in it.
 *
 *   node scripts/cli-npm.mjs pack <version> <binaries> <out>   Makes the packages from what the release built into <binaries>
 *   node scripts/cli-npm.mjs try <version> <out>               Installs them from <out> the way someone would, and runs it
 *
 * Each system's package names its os and cpu, so npm installs only the one that fits. @pandocs/cli asks for them all as
 * optional dependencies, which are written in here rather than in packages/cli, where they would send pnpm looking for
 * versions not published yet.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const MAIN = "packages/cli";

/** What the release builds, as Go names it, and as npm and Node do. */
const TARGETS = [
  { go: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { go: "darwin-amd64", os: "darwin", cpu: "x64" },
  { go: "linux-arm64", os: "linux", cpu: "arm64" },
  { go: "linux-amd64", os: "linux", cpu: "x64" },
  { go: "windows-arm64", os: "win32", cpu: "arm64" },
  { go: "windows-amd64", os: "win32", cpu: "x64" }
];
const nameOf = target => `@pandocs/cli-${target.os}-${target.cpu}`;
const fileOf = target => (target.os === "win32" ? "pandocs.exe" : "pandocs");
const tarballOf = (name, version) => `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function run(command, args, options = {}) {
  // npm and npx are scripts on Windows, which only a shell runs.
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result;
}

function pack(version, binaries, out) {
  const main = readJson(join(root, MAIN, "package.json"));
  if (main.version !== version) throw new Error(`${MAIN}/package.json says ${main.version}`);
  const notices = join(binaries, "THIRD-PARTY-NOTICES-cli.txt");
  if (!existsSync(notices)) throw new Error(`${notices} is missing`);
  const shared = {
    version,
    license: main.license,
    homepage: main.homepage,
    bugs: main.bugs,
    repository: main.repository
  };
  const work = mkdtempSync(join(tmpdir(), "pandocs-cli-npm-"));
  mkdirSync(out, { recursive: true });
  try {
    for (const target of TARGETS) {
      const binary = join(binaries, `pandocs-${target.go}${target.os === "win32" ? ".exe" : ""}`);
      if (!existsSync(binary)) throw new Error(`${binary} is missing`);
      const dir = join(work, target.go);
      mkdirSync(join(dir, "bin"), { recursive: true });
      copyFileSync(binary, join(dir, "bin", fileOf(target)));
      chmodSync(join(dir, "bin", fileOf(target)), 0o755);
      copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
      copyFileSync(notices, join(dir, "THIRD-PARTY-NOTICES.txt"));
      writeFileSync(
        join(dir, "README.md"),
        `# ${nameOf(target)}\n\nThe \`pandocs\` binary for ${target.os} on ${target.cpu}. Install [@pandocs/cli](https://www.npmjs.com/package/@pandocs/cli) instead, which picks this one by itself.\n`
      );
      writeJson(join(dir, "package.json"), {
        name: nameOf(target),
        ...shared,
        description: `The pandocs command line for ${target.os} on ${target.cpu}. Install @pandocs/cli instead.`,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin", "THIRD-PARTY-NOTICES.txt"],
        // Yarn's Plug'n'Play cannot run a binary from inside its zip files.
        preferUnplugged: true
      });
      run("npm", ["pack", "--silent", "--pack-destination", resolve(out)], {
        cwd: dir,
        stdio: ["ignore", "ignore", "inherit"]
      });
    }
    const dir = join(work, "cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(join(root, MAIN, "bin/pandocs.js"), join(dir, "bin/pandocs.js"));
    copyFileSync(join(root, MAIN, "README.md"), join(dir, "README.md"));
    copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
    writeJson(join(dir, "package.json"), {
      ...main,
      optionalDependencies: Object.fromEntries(TARGETS.map(target => [nameOf(target), version]))
    });
    run("npm", ["pack", "--silent", "--pack-destination", resolve(out)], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"]
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const file of readdirSync(out)
    .filter(file => file.endsWith(".tgz"))
    .sort())
    console.log(file);
}

/** Installs @pandocs/cli with each system's package taken from <out> instead of the registry, and runs what npm put there. */
function tryIt(version, out) {
  // With forward slashes, which npm reads as a path on Windows as well.
  const at = name => `file:${resolve(out, tarballOf(name, version)).replaceAll("\\", "/")}`;
  const here = TARGETS.find(target => target.os === process.platform && target.cpu === process.arch);
  if (!here) throw new Error(`nothing is built for ${process.platform}-${process.arch}`);
  const work = mkdtempSync(join(tmpdir(), "pandocs-cli-try-"));
  try {
    writeJson(join(work, "package.json"), {
      name: "try",
      private: true,
      dependencies: { "@pandocs/cli": at("@pandocs/cli") },
      overrides: Object.fromEntries(TARGETS.map(target => [nameOf(target), at(nameOf(target))]))
    });
    run("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: work });

    const installed = readdirSync(join(work, "node_modules/@pandocs")).sort();
    const expected = ["cli", `cli-${here.os}-${here.cpu}`];
    if (installed.join() !== expected.join())
      throw new Error(`npm installed ${installed.join(", ")} instead of ${expected.join(", ")}`);

    const said = run("npx", ["--no-install", "pandocs", "version"], {
      cwd: work,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8"
    }).stdout;
    process.stdout.write(said);
    if (!said.includes(version)) throw new Error("it says it is something else");

    // What the binary exits with comes through: 2 is a mistake in the command.
    const wrong = spawnSync("npx", ["--no-install", "pandocs", "no-such-command"], {
      cwd: work,
      stdio: "ignore",
      shell: process.platform === "win32"
    });
    if (wrong.status !== 2) throw new Error(`a mistake in the command exited with ${wrong.status} instead of 2`);
    console.log(`npm installs ${expected.map(name => `@pandocs/${name}`).join(" and ")}, and it runs.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main([command, ...rest]) {
  switch (command) {
    case "pack": {
      const [version, binaries, out] = rest;
      if (!version || !binaries || !out) break;
      pack(version, binaries, out);
      return 0;
    }
    case "try": {
      const [version, out] = rest;
      if (!version || !out) break;
      tryIt(version, out);
      return 0;
    }
  }
  console.error("Usage: cli-npm.mjs pack <version> <binaries> <out> | try <version> <out>");
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

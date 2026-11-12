import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/release.mjs");
const CHANGELOG =
  "# Changelog\n\nAbout this file.\n\n## Unreleased\n\n### Writing\n\n- Something new.\n\n## 0.1.0 - 2026-01-02\n\n- The first one.\n";

describe("what a release checks", () => {
  const made: string[] = [];
  const site = (version = "0.2.0", changelog = CHANGELOG) => {
    const root = mkdtempSync(join(tmpdir(), "pandocs-release-"));
    made.push(root);
    const files: Record<string, string> = {
      "package.json": `{\n  "name": "pandocs",\n  "version": "${version}"\n}\n`,
      "packages/client/package.json": `{\n  "name": "@pandocs/client",\n  "version": "${version}",\n  "dependencies": { "other": "1.2.3" }\n}\n`,
      "deploy/helm/pandocs/Chart.yaml": `name: pandocs\nversion: ${version}\nappVersion: "${version}"\nkubeVersion: ">=1.27.0-0"\n`,
      "docs/api/openapi.yaml": `openapi: 3.1.0\ninfo:\n  title: Pandocs API\n  version: ${version}\nservers:\n  - url: /api/v1\n`,
      "compose.yaml": `services:\n  pandocs:\n    image: ghcr.io/o/pandocs:\${PANDOCS_VERSION:-${version}}\n  converter:\n    image: ghcr.io/o/pandocs-converter:\${PANDOCS_VERSION:-${version}}\n`,
      "CHANGELOG.md": changelog,
      LICENSE: "Apache\n",
      NOTICE: "Pandocs\n"
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const run = (root: string, ...args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
    return { status, stdout, stderr };
  };

  afterEach(() => {
    for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("holds this repository to one version", () => {
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    expect(run(ROOT, "check", version, "--rehearsal")).toMatchObject({ status: 0 });
  });

  it("says what does not agree, instead of going ahead", () => {
    const root = site();
    writeFileSync(join(root, "deploy/helm/pandocs/Chart.yaml"), 'name: pandocs\nversion: 0.2.0\nappVersion: "0.1.9"\n');
    const { status, stderr } = run(root, "check", "0.2.0", "--rehearsal");
    expect(status).toBe(1);
    expect(stderr).toContain("deploy/helm/pandocs/Chart.yaml says 0.1.9");
  });

  it("wants a release to be in the changelog, and lets a rehearsal use what is unreleased", () => {
    const root = site();
    expect(run(root, "check", "0.2.0").stderr).toContain("says nothing about 0.2.0");
    expect(run(root, "check", "0.2.0", "--rehearsal").status).toBe(0);
    expect(run(root, "notes", "0.2.0", "--rehearsal").stdout).toBe("### Writing\n\n- Something new.\n");
    expect(run(root, "notes", "0.1.0").stdout).toBe("- The first one.\n");
    expect(run(root, "notes", "0.2.0").status).toBe(1);
    expect(run(site("0.2.0", "# Changelog\n\n## Unreleased\n"), "check", "0.2.0", "--rehearsal").stderr).toContain(
      "nothing unreleased"
    );
  });

  it("refuses what is not a version", () => {
    for (const version of ["v0.2.0", "0.2", "latest", "0.2.0;rm"])
      expect(run(site(version), "check", version, "--rehearsal").stderr).toContain("is not a version");
  });

  it("sets a version everywhere, and only the version", () => {
    const root = site("0.1.0");
    expect(run(root, "set", "0.2.0-rc.1", "--date", "2026-12-01")).toMatchObject({ status: 0 });
    expect(run(root, "check", "0.2.0-rc.1")).toMatchObject({ status: 0 });
    expect(readFileSync(join(root, "packages/client/package.json"), "utf8")).toContain('"other": "1.2.3"');
    expect(readFileSync(join(root, "deploy/helm/pandocs/Chart.yaml"), "utf8")).toContain('kubeVersion: ">=1.27.0-0"');
    expect(readFileSync(join(root, "compose.yaml"), "utf8")).toContain(
      "pandocs-converter:${PANDOCS_VERSION:-0.2.0-rc.1}"
    );
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## Unreleased\n\n## 0.2.0-rc.1 - 2026-12-01\n\n### Writing");
    expect(run(root, "notes", "0.2.0-rc.1").stdout).toBe("### Writing\n\n- Something new.\n");
  });

  it("has nothing to release when nothing has happened, or twice", () => {
    expect(
      run(site("0.1.0", "# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-01-02\n\n- The first one.\n"), "set", "0.2.0")
        .stderr
    ).toContain("nothing unreleased");
    const root = site("0.1.0");
    run(root, "set", "0.2.0");
    expect(run(root, "set", "0.2.0").stderr).toContain("already has 0.2.0");
  });
});

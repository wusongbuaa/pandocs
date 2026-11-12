import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const VENDOR = join(import.meta.dirname, "../vendor");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe.each(["rspress", "shadcn"])("vendor/%s", name => {
  it("stays a verbatim copy, so the look and upgrades stay official", () => {
    const vendor = join(VENDOR, name);
    const hash = createHash("sha256");
    for (const file of files(vendor).filter(path => !path.endsWith("UPSTREAM.md")).sort()) {
      hash.update(relative(vendor, file)).update("\0").update(readFileSync(file));
    }
    // A change here means the copy was edited. Record why in UPSTREAM.md, or undo it; see "升级" there for new versions.
    expect(hash.digest("hex")).toMatchSnapshot();
  });
});

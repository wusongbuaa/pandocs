#!/usr/bin/env node
// Runs the pandocs binary for this system, which npm installed from the package of the same version made for it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const target = `${process.platform}-${process.arch}`;
const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

let binary;
try {
  binary = require.resolve(`@pandocs/cli-${target}/bin/pandocs${process.platform === "win32" ? ".exe" : ""}`);
} catch {
  console.error(
    SUPPORTED.includes(target)
      ? `pandocs: @pandocs/cli-${target} is missing. It is an optional dependency of @pandocs/cli, so install again without --omit=optional or --no-optional.`
      : `pandocs: there is no build for ${target} on npm. The releases have the systems there are: https://github.com/wusongbuaa/pandocs/releases`
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Stay until the binary has finished, which may mean finishing a write when told to stop. Windows tells it by itself.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (process.platform !== "win32") child.kill(signal);
  });
}

child.on("error", error => {
  console.error(`pandocs: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

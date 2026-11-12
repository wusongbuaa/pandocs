#!/usr/bin/env bash
# Run once, when the container is made.
set -euo pipefail

# Node 26 comes without Corepack, so pnpm is installed at the version package.json names.
npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"
# A modules folder from another system, such as one the host left, is replaced without asking.
pnpm install --frozen-lockfile --config.confirm-modules-purge=false
# The database `pnpm dev` uses, beside the one the tests make their own in.
node --input-type=module -e '
import pg from "pg";
const client = new pg.Client(process.env.TEST_DATABASE_URL);
await client.connect();
await client.query("CREATE DATABASE pandocs").catch(error => { if (error.code !== "42P04") throw error; });
await client.end();
'
# Playwright's installer hangs while unpacking on Node 26, so it runs on 22. See CONTRIBUTING.
version="$(node -p 'require("./package.json").devDependencies["@playwright/test"]')"
bash -ic "nvm exec 22 npx --yes playwright@$version install --with-deps chromium"

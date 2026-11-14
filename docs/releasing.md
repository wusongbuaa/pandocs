# Releasing

A release is a tag, `vX.Y.Z`, on a commit whose CI passed. Everything else follows from the tag.

## What a release is made of

| What | Where it goes | Decided by |
| --- | --- | --- |
| The command line, for six platforms, with checksums | The GitHub release | Always |
| The image, for `linux/amd64` and `linux/arm64` | `ghcr.io/<owner>/pandocs` | Always |
| The converter's image, for the same two | `ghcr.io/<owner>/pandocs-converter` | Always |
| The Helm chart | `oci://ghcr.io/<owner>/charts/pandocs`, and the GitHub release | Always |
| The Go client | The tag `sdks/go/vX.Y.Z`, which is what Go looks for | Always |
| `@pandocs/client` and `@pandocs/embed` | npm | The repository variable `PUBLISH_NPM`, and the secret `NPM_TOKEN` |
| The command line again, as `@pandocs/cli` and a package for each platform such as `@pandocs/cli-linux-x64` | npm | The same |

Each image, the command line and the chart carry a signed record of the workflow run that built them, and the images an SBOM too. Anyone can check one with `gh attestation verify <file or oci://image> --repo wusongbuaa/pandocs`. What goes to npm carries npm's provenance, shown on the package's page.

## Trying it without releasing

```bash
gh workflow run release.yml -f version=0.2.0
```

This builds everything, tries each thing the way someone would use it, and publishes nothing. It takes as long as a release, and uses as many CI minutes. The version has to be the one the files say, but it does not have to be in the changelog yet.

Parts of it can be tried on your own machine:

```bash
node scripts/release.mjs check 0.2.0 --rehearsal
scripts/try-packages.sh 0.2.0                 # packs what gets published, and uses it from outside this repository
node scripts/cli-npm.mjs pack 0.2.0 cli/dist out/cli-npm && node scripts/cli-npm.mjs try 0.2.0 out/cli-npm
                                              # the command line for npm, from binaries built as the release builds them
docker build -t pandocs:try . && scripts/try-image.sh pandocs:try 0.2.0
```

## Making one

1. Look through *Unreleased* in the [changelog](../CHANGELOG.md). Write for someone running or using it, not for someone reading the commits. Anything they have to do goes under *Upgrading*.
2. Set the version, which also gives the unreleased part its heading:

   ```bash
   node scripts/release.mjs set 0.2.0
   scripts/generate-sdks.sh   # changes nothing unless the API has changed
   git commit -am "chore: release 0.2.0"
   ```

3. Push it, and wait for CI to pass. A release refuses a commit it did not pass on.
4. Tag that commit:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

A version with a suffix, such as `0.2.0-rc.1`, is marked as a pre-release on GitHub and `next` on npm, and does not move the image's `latest` tag.

## Updating, and going back

A new version updates the database when it starts, and replicas of the old one keep working during an update, so going forward needs nothing else. Changes to the database only add to it. Going back to the previous version therefore works, as long as what the new version added is not needed: the old version does not use new tables or columns. Before changing this rule for a release, say so under *Upgrading*.

## If something goes wrong

A tag can be published again by re-running the failed jobs, and what is already out is left alone. What has been released cannot be changed in place, since people may already have it: fix it, and release the next patch version. npm never lets a version be used twice.

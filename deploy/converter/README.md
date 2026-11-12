# The converter

A service that turns files into Markdown for Pandocs, for what its built-in conversion cannot read: scans, and the old Office formats `.doc`, `.xls` and `.ppt`. Pandocs sends it files when `PANDOCS_EXTRACT_URL` points at its `/convert`. How it fits in, and how to run it with Docker Compose or Kubernetes, is in [Importing files](../../docs/importing-files.md#a-better-converter).

- Old Office files are saved in their new format by LibreOffice first.
- [Docling](https://github.com/docling-project/docling) then converts, when `DOCLING_URL` points at a [docling-serve](https://github.com/docling-project/docling-serve). It finds the layout and recognizes the text of scans.
- Without it, [MarkItDown](https://github.com/microsoft/markitdown) converts, which does not read pictures.
- Pictures come out of the Markdown as files named by their SHA-256, the way Pandocs keeps them.

```bash
docker build -f deploy/converter/Dockerfile -t pandocs-converter .
docker run -p 127.0.0.1:8090:8090 -e CONVERTER_TOKEN="$(openssl rand -hex 24)" -e DOCLING_URL=http://docling:5001 pandocs-converter
```

It does not start without a token, since anyone who could reach it could have files converted on your machine, and Pandocs sends the same one as `PANDOCS_EXTRACT_TOKEN`. Where nothing but Pandocs can reach it, `CONVERTER_REQUIRE_TOKEN=false` lets it start without one. A file waits for its turn before it is read, and one that has waited too long is told to come back later.

It is plain Python with the standard library, apart from MarkItDown. `server.py` says what it answers and when.

`requirements.txt` says which MarkItDown, and `requirements.lock` holds it and everything it needs, each at one version with its hashes, which is what the image installs. After changing the first, make the second again:

```bash
docker run --rm -v "$PWD/deploy/converter:/work" -w /work python:3.12-slim-bookworm sh -c \
  "pip install pip-tools==7.5.2 && pip-compile --generate-hashes --allow-unsafe --strip-extras --no-header --output-file requirements.lock requirements.txt"
```

## Tests

```bash
docker run --rm -v "$PWD/deploy/converter/tests:/tests:ro" pandocs-converter python -m unittest discover -s /tests
PANDOCS_CONVERTER_URL=http://127.0.0.1:8090/convert pnpm exec vitest run packages/server/test/converter.test.ts
```

The first are its own, inside the image, where LibreOffice makes the old files to read. The second is Pandocs' side against one running.

## Licenses

The image holds this repository's `LICENSE` and `NOTICE`, and `/app/THIRD-PARTY-NOTICES.txt` with the licenses of its Python packages. Its Debian packages, LibreOffice among them, mostly under the MPL-2.0, keep theirs in `/usr/share/doc/<package>/copyright`, and their source comes from Debian. Docling is MIT, and its own image carries its notices.

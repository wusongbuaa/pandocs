# The converter Pandocs can send files to. Built from the repository's root, for its license:
#   docker build -f deploy/converter/Dockerfile -t pandocs-converter .
# By digest, so that the same build gives the same image; Dependabot moves it on.
FROM python:3.14-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b

# For old Office formats. Built with LIBREOFFICE=false, the image is a good deal smaller and refuses them.
ARG LIBREOFFICE=true
RUN if [ "$LIBREOFFICE" = true ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
# Every package at one version, checked by its hash, what MarkItDown needs included. requirements.txt says what is wanted;
# deploy/converter/README.md says how to make the lock again from it.
COPY deploy/converter/requirements.lock ./
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes -r requirements.lock
COPY deploy/converter/server.py deploy/converter/notices.py ./
COPY LICENSE NOTICE ./
RUN python notices.py > THIRD-PARTY-NOTICES.txt && rm notices.py

RUN useradd --system --uid 10001 --home-dir /tmp converter
USER converter
ENV PORT=8090 HOME=/tmp PYTHONUNBUFFERED=1
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/healthz', timeout=2)"]
CMD ["python", "server.py"]

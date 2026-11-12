"""The licenses of the Python packages in this image, written out as THIRD-PARTY-NOTICES.txt when it is built."""

import importlib.metadata
import re

LICENSE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice)[^/]*$", re.IGNORECASE)


def license_of(metadata):
    if metadata.get("License-Expression"):
        return metadata["License-Expression"]
    named = (metadata.get("License") or "").strip()
    # Some packages put the whole text here, which is printed further down anyway.
    if named and "\n" not in named and len(named) < 100:
        return named
    classifiers = [line.split(" :: ")[-1] for line in metadata.get_all("Classifier") or [] if line.startswith("License ::")]
    return ", ".join(classifiers) or "See the text below"


def main():
    parts = [
        "The Pandocs converter image includes the following Python packages. The packages from Debian, LibreOffice among\n"
        "them, keep their licenses in /usr/share/doc/<package>/copyright, and their source comes from Debian.\n"
    ]
    for dist in sorted(importlib.metadata.distributions(), key=lambda dist: dist.metadata["Name"].lower()):
        texts = []
        for file in dist.files or []:
            if ".dist-info/" in str(file) and LICENSE_FILE.search(str(file)):
                texts.append(file.locate().read_bytes().decode("utf-8", errors="replace").strip())
        body = "\n\n".join(texts)
        parts.append(f"{'-' * 72}\n{dist.metadata['Name']} {dist.version}\nLicense: {license_of(dist.metadata)}\n" + (f"\n{body}\n" if body else ""))
    print("\n".join(parts))


if __name__ == "__main__":
    main()

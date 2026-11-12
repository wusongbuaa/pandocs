"""Turns a file into Markdown for Pandocs, which sends files here when PANDOCS_EXTRACT_URL points at /convert.

Pandocs posts a file's bytes, with its type in Content-Type and its name URL-encoded in X-Filename, and gets back
JSON: {"markdown", "title"?, "warnings", "files"}. Pictures move out of the Markdown into "files", each named
assets/<sha256>.<ext>, which is how Pandocs stores them. A 4xx answer means the file will never convert, and Pandocs
tells the person; it tries anything else again later.

Old Office formats go through LibreOffice first. Then Docling reads the file when DOCLING_URL is set, which finds the
layout and recognizes the text of scans, and MarkItDown does otherwise.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8090"))
TOKEN = os.environ.get("CONVERTER_TOKEN", "")
# Without a token anyone who can reach the port has files converted, at up to 100 MiB and minutes of LibreOffice each, so
# it takes saying so to run without one, as Docker Compose does where only Pandocs can reach it.
REQUIRE_TOKEN = os.environ.get("CONVERTER_REQUIRE_TOKEN", "true").strip().lower() != "false"
DOCLING_URL = os.environ.get("DOCLING_URL", "").rstrip("/")
MAX_BYTES = int(os.environ.get("CONVERTER_MAX_BYTES", str(100 * 1024 * 1024)))
# Reading a large scan takes a lot of memory, so files beyond this many wait their turn.
TURNS = threading.BoundedSemaphore(int(os.environ.get("CONVERTER_CONCURRENCY", "2")))
# Pandocs gives up on an answer after ten minutes.
DEADLINE_SECONDS = 9 * 60
# How long a file waits for a turn before it is told to come back later. It waits unread, so waiting costs no memory.
TURN_WAIT_SECONDS = DEADLINE_SECONDS

# What Pandocs sends, by type, and by name for a type it could not tell.
EXTENSIONS = {
    "text/html": "html",
    "text/csv": "csv",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
}
MODERN = {"doc": "docx", "xls": "xlsx", "ppt": "pptx"}
# The pictures Pandocs shows. Anything else, such as the EMF drawings Office files carry, is left out and counted.
PICTURES = {"png": "png", "jpeg": "jpg", "jpg": "jpg", "gif": "gif", "webp": "webp", "bmp": "bmp"}
DATA_PICTURE = re.compile(r"!\[([^\]]*)\]\(\s*data:image/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*?)\s*\)")

# What a person may read, in the language Pandocs asks for with Accept-Language.
MESSAGES = {
    "unsupported": ("This converter does not read {0}", "转换服务不支持这种文件：{0}"),
    "no_libreoffice": ("Old Office formats need LibreOffice, and this converter was built without it", "旧版 Office 文件需要 LibreOffice，这个转换服务构建时没有包含它"),
    "libreoffice_slow": ("LibreOffice took too long to open this file", "LibreOffice 打开这个文件用时太长"),
    "libreoffice_failed": ("LibreOffice could not open this file", "LibreOffice 打不开这个文件"),
    "markitdown_unsupported": ("MarkItDown does not read this type of file", "MarkItDown 不支持这种文件"),
    "markitdown_failed": ("MarkItDown could not read this file", "MarkItDown 读不了这个文件"),
    "no_text": ("No text was found, so this may be a scan. Run the converter with Docling to recognize its text.", "没有找到文字，可能是扫描件。转换服务接上 Docling 后才能识别扫描件里的文字。"),
    "docling_refused": ("Docling refused the file ({0})", "Docling 拒绝了这个文件（{0}）"),
    "docling_failed": ("Docling could not read this file", "Docling 读不了这个文件"),
    "docling_down": ("Docling is not answering", "Docling 没有响应"),
    "docling_status": ("Docling answered {0}", "Docling 返回 {0}"),
    "docling_slow": ("Docling took too long", "Docling 用时太长"),
    "pictures_left_out": ("{0} pictures could not be kept: drawings Office makes, for example, cannot be shown", "有 {0} 张图片没能保留，比如 Office 自带的绘图无法显示"),
    "picture_left_out": ("A picture could not be kept: drawings Office makes, for example, cannot be shown", "有 1 张图片没能保留，比如 Office 自带的绘图无法显示"),
    "token": ("This converter needs its token", "转换服务需要令牌"),
    "length": ("The file's length is needed", "需要知道文件的长度"),
    "too_large": ("The file is too large", "文件太大"),
    "busy": ("The converter is busy. Try again in a moment", "转换服务正忙，请稍后再试"),
    "failed": ("The conversion failed", "转换失败"),
    "not_found": ("Not found", "没有这个地址"),
}


def say(language, key, *args):
    english, chinese = MESSAGES[key]
    return (chinese if language == "zh" else english).format(*args)


def language_of(accepted):
    return "zh" if (accepted or "").strip().lower().startswith("zh") else "en"


class Refused(Exception):
    """The file will never convert. Pandocs tells the person, and does not try again."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Unavailable(Exception):
    """Something this service relies on is not answering. Pandocs tries again later."""


class Busy(Exception):
    """Every turn is taken, for longer than a file should wait. Pandocs tries again later."""


def extension_of(content_type, filename, language):
    known = EXTENSIONS.get(content_type.split(";")[0].strip().lower())
    if known:
        return known
    named = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if named in EXTENSIONS.values():
        return named
    raise Refused(415, say(language, "unsupported", content_type or filename or "?"))


def modernize(path, workdir, language):
    """LibreOffice saves an old Office file in its new format, which everything after it reads."""
    soffice = shutil.which("soffice")
    if not soffice:
        raise Refused(415, say(language, "no_libreoffice"))
    target = MODERN[path.rsplit(".", 1)[1]]
    outdir = os.path.join(workdir, "modern")
    # A profile of its own, so that conversions never wait on each other's lock.
    profile = "file://" + os.path.join(workdir, "profile")
    try:
        subprocess.run(
            [soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore", "--convert-to", target, "--outdir", outdir, path],
            check=True, capture_output=True, timeout=180,
        )
    except subprocess.TimeoutExpired as error:
        raise Refused(422, say(language, "libreoffice_slow")) from error
    except subprocess.CalledProcessError as error:
        raise Refused(422, say(language, "libreoffice_failed")) from error
    converted = os.path.join(outdir, os.path.basename(path).rsplit(".", 1)[0] + "." + target)
    # It can end well and still have written nothing.
    if not os.path.exists(converted):
        raise Refused(422, say(language, "libreoffice_failed"))
    return converted


_markitdown = None
_markitdown_lock = threading.Lock()


def with_markitdown(path, language):
    global _markitdown
    from markitdown import FileConversionException, MarkItDown, UnsupportedFormatException

    with _markitdown_lock:
        if _markitdown is None:
            _markitdown = MarkItDown(enable_plugins=False)
    try:
        result = _markitdown.convert_local(path, keep_data_uris=True)
    except UnsupportedFormatException as error:
        raise Refused(415, say(language, "markitdown_unsupported")) from error
    except FileConversionException as error:
        raise Refused(422, say(language, "markitdown_failed")) from error
    warnings = []
    if path.endswith(".pdf") and not result.markdown.strip():
        warnings.append(say(language, "no_text"))
    return result.markdown, result.title, warnings


def multipart(fields, file_field, filename, content):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def docling(language, method, path, body=None, content_type=None):
    request = urllib.request.Request(DOCLING_URL + path, data=body, method=method)
    if content_type:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if 400 <= error.code < 500 and error.code not in (404, 408, 429):
            raise Refused(422, say(language, "docling_refused", error.code)) from error
        raise Unavailable(say(language, "docling_status", error.code)) from error
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        raise Unavailable(say(language, "docling_down")) from error


def with_docling(path, language):
    with open(path, "rb") as file:
        body, content_type = multipart([("to_formats", "md"), ("image_export_mode", "embedded")], "files", "document." + path.rsplit(".", 1)[1], file.read())
    # Asked to wait for the answer, Docling gives up after two minutes, which a long scan can take. So it is asked to start, and then how it is going.
    task = docling(language, "POST", "/v1/convert/file/async", body, content_type)
    deadline = time.monotonic() + DEADLINE_SECONDS
    while task.get("task_status") in ("pending", "started"):
        if time.monotonic() > deadline:
            raise Unavailable(say(language, "docling_slow"))
        task = docling(language, "GET", f"/v1/status/poll/{task['task_id']}?wait=5")
    if task.get("task_status") == "failure":
        raise Refused(422, say(language, "docling_failed") + (f": {task['error_message'][:300]}" if task.get("error_message") else ""))
    result = docling(language, "GET", f"/v1/result/{task['task_id']}")
    errors = [item.get("error_message", "") for item in result.get("errors") or [] if item.get("error_message")]
    markdown = (result.get("document") or {}).get("md_content") or ""
    if result.get("status") not in ("success", "partial_success"):
        raise Refused(422, say(language, "docling_failed") + (f": {'; '.join(errors)[:300]}" if errors else ""))
    return markdown, None, errors


def take_pictures(markdown, language="en"):
    """Pictures written into the Markdown as data become files Pandocs keeps, named by what they hold."""
    files = {}
    left_out = 0

    def keep(match):
        nonlocal left_out
        alt, kind, data = match.group(1), match.group(2).lower(), match.group(3)
        extension = PICTURES.get(kind)
        try:
            content = base64.b64decode(re.sub(r"\s+", "", data), validate=True)
        except ValueError:
            content = b""
        if not extension or not content:
            left_out += 1
            return alt
        name = f"assets/{hashlib.sha256(content).hexdigest()}.{extension}"
        files[name] = base64.b64encode(content).decode()
        return f"![{alt}]({name})"

    markdown = DATA_PICTURE.sub(keep, markdown)
    warnings = [say(language, "picture_left_out") if left_out == 1 else say(language, "pictures_left_out", left_out)] if left_out else []
    return markdown, [{"path": name, "data": data} for name, data in files.items()], warnings


def convert(content, content_type, filename, language="en"):
    extension = extension_of(content_type, filename, language)
    with tempfile.TemporaryDirectory(prefix="convert-") as workdir:
        path = os.path.join(workdir, f"document.{extension}")
        with open(path, "wb") as file:
            file.write(content)
        if extension in MODERN:
            path = modernize(path, workdir, language)
        markdown, title, warnings = with_docling(path, language) if DOCLING_URL else with_markitdown(path, language)
    markdown, files, left_out = take_pictures(markdown, language)
    answer = {"markdown": markdown, "warnings": warnings + left_out, "files": files}
    if title:
        answer["title"] = title
    return answer


def log(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "pandocs-converter"

    def do_GET(self):
        if self.path == "/healthz":
            self.answer(200, {"ok": True})
        else:
            self.answer(404, {"error": say(language_of(self.headers.get("Accept-Language")), "not_found")})

    def do_POST(self):
        started = time.monotonic()
        status = 500
        content_type = self.headers.get("Content-Type", "")
        language = language_of(self.headers.get("Accept-Language"))
        try:
            if self.path != "/convert":
                raise Refused(404, say(language, "not_found"))
            if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {TOKEN}".encode()):
                raise Refused(401, say(language, "token"))
            length = int(self.headers.get("Content-Length") or -1)
            if length < 0:
                raise Refused(411, say(language, "length"))
            if length > MAX_BYTES:
                raise Refused(413, say(language, "too_large"))
            # A turn first, then the file: files waiting stay where they are rather than all in memory at once.
            if not TURNS.acquire(timeout=TURN_WAIT_SECONDS):
                raise Busy(say(language, "busy"))
            try:
                content = self.rfile.read(length)
                filename = urllib.parse.unquote(self.headers.get("X-Filename", ""))
                answer = convert(content, content_type, filename, language)
            finally:
                TURNS.release()
            status = 200
            self.answer(200, answer)
        except Refused as error:
            status = error.status
            self.answer(error.status, {"error": str(error)})
        except Busy as error:
            status = 503
            self.close_connection = True
            self.answer(503, {"error": str(error)}, {"Retry-After": "30"})
        except Unavailable as error:
            status = 503
            self.answer(503, {"error": str(error)})
        except Exception:
            traceback.print_exc()
            self.answer(500, {"error": say(language, "failed")})
        finally:
            # Not the file's name, which may say more than its owner wants in a log.
            log(event="converter.request", status=status, type=content_type, ms=round((time.monotonic() - started) * 1000))

    def answer(self, status, body, headers=None):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


def setting_problem():
    """What keeps this from starting, if anything."""
    if not TOKEN and REQUIRE_TOKEN:
        return "CONVERTER_TOKEN is not set, so anyone who can reach this port could have files converted. Set it, and PANDOCS_EXTRACT_TOKEN to the same, or set CONVERTER_REQUIRE_TOKEN=false where only Pandocs can reach this."
    return None


def main():
    problem = setting_problem()
    if problem:
        log(event="converter.refused_to_start", reason=problem)
        raise SystemExit(2)
    if not TOKEN:
        log(event="converter.no_token", note="Anyone who can reach this port can have files converted")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    log(event="converter.started", port=PORT, engine="docling" if DOCLING_URL else "markitdown", libreoffice=bool(shutil.which("soffice")))
    server.serve_forever()


if __name__ == "__main__":
    main()

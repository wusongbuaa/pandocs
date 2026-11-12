"""The converter's own tests, run inside its image:
docker run --rm -v "$PWD/deploy/converter/tests:/tests:ro" pandocs-converter python -m unittest discover -s /tests
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import server

# The smallest PNG there is.
PICTURE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
PICTURE_NAME = f"assets/{hashlib.sha256(PICTURE).hexdigest()}.png"
DATA = base64.b64encode(PICTURE).decode()


def serve(handler):
    running = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=running.serve_forever, daemon=True).start()
    return running, f"http://127.0.0.1:{running.server_address[1]}"


def post(url, body, headers):
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class TheService(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.TOKEN = "test-token"
        cls.running, base = serve(server.Handler)
        cls.url = f"{base}/convert"

    @classmethod
    def tearDownClass(cls):
        cls.running.shutdown()
        cls.running.server_close()
        server.TOKEN = ""

    def send(self, body, content_type, filename="文件", token="test-token", language="en"):
        headers = {"Content-Type": content_type, "X-Filename": urllib.request.quote(filename), "Accept-Language": language}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return post(self.url, body, headers)

    def test_answers_with_markdown_and_takes_the_pictures_out(self):
        html = f'<html><head><title>退货</title></head><body><h1>退货流程</h1><p>七天内<b>无理由</b>退货。</p><img alt="示意图" src="data:image/png;base64,{DATA}"></body></html>'
        status, answer = self.send(html.encode(), "text/html", "退货 流程.html")
        self.assertEqual(status, 200)
        self.assertIn("# 退货流程", answer["markdown"])
        self.assertIn(f"![示意图]({PICTURE_NAME})", answer["markdown"])
        self.assertEqual(answer["files"], [{"path": PICTURE_NAME, "data": DATA}])
        self.assertEqual(answer["title"], "退货")

    def test_reads_a_table(self):
        status, answer = self.send("名称,数量\n红楼梦,3\n".encode(), "text/csv")
        self.assertEqual(status, 200)
        self.assertIn("| 红楼梦 | 3 |", answer["markdown"])

    def test_wants_its_token(self):
        self.assertEqual(self.send(b"x", "text/csv", token="wrong")[0], 401)
        self.assertEqual(self.send(b"x", "text/csv", token="")[0], 401)

    def test_refuses_what_it_does_not_read_for_good(self):
        status, answer = self.send(b"\x00\x01", "image/x-unknown", "picture.unknown")
        self.assertEqual(status, 415)
        self.assertIn("does not read", answer["error"])

    def test_says_why_in_the_language_pandocs_asks_for(self):
        status, answer = self.send(b"\x00", "image/x-unknown", "picture.unknown", language="zh")
        self.assertEqual(status, 415)
        self.assertEqual(answer["error"], "转换服务不支持这种文件：image/x-unknown")

    def test_goes_by_the_name_when_the_type_says_nothing(self):
        status, answer = self.send("a,b\n1,2\n".encode(), "application/octet-stream", "表.csv")
        self.assertEqual(status, 200)
        self.assertIn("| 1 | 2 |", answer["markdown"])

    def test_refuses_a_file_too_large(self):
        limit = server.MAX_BYTES
        server.MAX_BYTES = 10
        try:
            self.assertEqual(self.send(b"x" * 11, "text/csv")[0], 413)
        finally:
            server.MAX_BYTES = limit

    def test_says_to_come_back_later_when_every_turn_is_taken_without_reading_the_file(self):
        waited = server.TURN_WAIT_SECONDS
        server.TURN_WAIT_SECONDS = 0.1
        taken = [server.TURNS.acquire() for _ in range(int(os.environ.get("CONVERTER_CONCURRENCY", "2")))]
        try:
            status, answer = self.send(b"a,b\n1,2\n", "text/csv")
            self.assertEqual((status, answer["error"]), (503, "The converter is busy. Try again in a moment"))
        finally:
            for _ in taken:
                server.TURNS.release()
            server.TURN_WAIT_SECONDS = waited


class ItsSettings(unittest.TestCase):
    def test_will_not_start_without_a_token_unless_told_it_may(self):
        token, required = server.TOKEN, server.REQUIRE_TOKEN
        try:
            server.TOKEN, server.REQUIRE_TOKEN = "", True
            self.assertIn("CONVERTER_TOKEN", server.setting_problem())
            server.REQUIRE_TOKEN = False
            self.assertIsNone(server.setting_problem())
            server.TOKEN, server.REQUIRE_TOKEN = "a-token", True
            self.assertIsNone(server.setting_problem())
        finally:
            server.TOKEN, server.REQUIRE_TOKEN = token, required


@unittest.skipUnless(shutil.which("soffice"), "built without LibreOffice")
class OldOfficeFormats(unittest.TestCase):
    def make(self, text, kind, target):
        """LibreOffice makes the old file too, from HTML for Word and CSV for Excel."""
        with tempfile.TemporaryDirectory() as workdir:
            source = os.path.join(workdir, f"source.{kind}")
            with open(source, "w", encoding="utf-8") as file:
                file.write(text)
            # A CSV is read as UTF-8 only when told: comma, double quote, UTF-8, from the first line.
            read_as = ["--infilter=CSV:44,34,76,1"] if kind == "csv" else []
            subprocess.run(["soffice", f"-env:UserInstallation=file://{workdir}/profile", "--headless", *read_as, "--convert-to", target, "--outdir", workdir, source], check=True, capture_output=True, timeout=180)
            with open(os.path.join(workdir, f"source.{target.split(':')[0]}"), "rb") as file:
                return file.read()

    def test_reads_an_old_word_file(self):
        doc = self.make("<h1>请假制度</h1><p>每年五天带薪年假。</p><table border=1><tr><th>工龄</th><th>天数</th></tr><tr><td>一年</td><td>五天</td></tr></table>", "html", "doc:MS Word 97")
        answer = server.convert(doc, "application/msword", "制度.doc")
        self.assertIn("请假制度", answer["markdown"])
        self.assertIn("五天", answer["markdown"])

    def test_reads_an_old_excel_file(self):
        xls = self.make("书名,数量\n红楼梦,12\n", "csv", "xls:MS Excel 97")
        answer = server.convert(xls, "application/vnd.ms-excel", "书单.xls")
        self.assertIn("红楼梦", answer["markdown"])


class FakeDocling(BaseHTTPRequestHandler):
    """Answers like docling-serve: a task that is pending, then done, then its result."""

    result = {}
    seen = []

    def do_POST(self):
        FakeDocling.seen.append((self.path, self.rfile.read(int(self.headers["Content-Length"]))))
        self.reply({"task_id": "task-1", "task_status": "pending"})

    def do_GET(self):
        FakeDocling.seen.append((self.path, b""))
        if self.path.startswith("/v1/status/poll/"):
            self.reply({"task_id": "task-1", "task_status": FakeDocling.result.get("status", "success")})
        else:
            self.reply(FakeDocling.result)

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


class WithDocling(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.running, server.DOCLING_URL = serve(FakeDocling)

    @classmethod
    def tearDownClass(cls):
        cls.running.shutdown()
        cls.running.server_close()
        server.DOCLING_URL = ""

    def setUp(self):
        FakeDocling.seen = []

    def test_hands_the_file_over_and_waits_for_it(self):
        FakeDocling.result = {"status": "success", "errors": [], "document": {"md_content": f"## 采购申请单\n\n![Image](data:image/png;base64,{DATA})"}}
        answer = server.convert(b"%PDF-1.4 scanned", "application/pdf", "扫描件.pdf")
        self.assertEqual(answer["markdown"], f"## 采购申请单\n\n![Image]({PICTURE_NAME})")
        self.assertEqual(answer["files"], [{"path": PICTURE_NAME, "data": DATA}])
        path, body = FakeDocling.seen[0]
        self.assertEqual(path, "/v1/convert/file/async")
        self.assertIn(b'name="image_export_mode"\r\n\r\nembedded', body)
        self.assertIn(b'filename="document.pdf"', body)
        self.assertIn(b"%PDF-1.4 scanned", body)
        self.assertTrue(FakeDocling.seen[1][0].startswith("/v1/status/poll/task-1"))
        self.assertEqual(FakeDocling.seen[-1][0], "/v1/result/task-1")

    def test_passes_on_what_only_partly_worked(self):
        FakeDocling.result = {"status": "partial_success", "errors": [{"error_message": "第 3 页读不出来"}], "document": {"md_content": "前两页"}}
        self.assertEqual(server.convert(b"%PDF", "application/pdf", "a.pdf")["warnings"], ["第 3 页读不出来"])

    def test_refuses_what_docling_could_not_read(self):
        FakeDocling.result = {"status": "failure", "errors": [{"error_message": "损坏"}]}
        with self.assertRaises(server.Refused) as refused:
            server.convert(b"%PDF", "application/pdf", "a.pdf")
        self.assertEqual(refused.exception.status, 422)

    def test_asks_again_later_when_docling_is_down(self):
        address = server.DOCLING_URL
        server.DOCLING_URL = "http://127.0.0.1:9"
        try:
            with self.assertRaises(server.Unavailable):
                server.convert(b"%PDF", "application/pdf", "a.pdf")
        finally:
            server.DOCLING_URL = address


class Pictures(unittest.TestCase):
    def test_keeps_each_picture_once_and_counts_what_cannot_be_shown(self):
        markdown = f"![一](data:image/png;base64,{DATA})\n![二](data:image/png;base64,{DATA})\n![图](data:image/x-emf;base64,AAAA)\n![坏](data:image/png;base64,A)"
        text, files, warnings = server.take_pictures(markdown)
        self.assertEqual(text, f"![一]({PICTURE_NAME})\n![二]({PICTURE_NAME})\n图\n坏")
        self.assertEqual(files, [{"path": PICTURE_NAME, "data": DATA}])
        self.assertEqual(warnings, ["2 pictures could not be kept: drawings Office makes, for example, cannot be shown"])


if __name__ == "__main__":
    unittest.main()

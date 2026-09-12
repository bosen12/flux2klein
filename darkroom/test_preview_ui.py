import io
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from email.message import Message

sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview_ui


def make_handler(body=b"", *, content_length=None, accept_encoding=""):
    handler = object.__new__(preview_ui.Handler)
    headers = Message()
    if content_length is not None:
        headers["Content-Length"] = str(content_length)
    if accept_encoding:
        headers["Accept-Encoding"] = accept_encoding
    handler.headers = headers
    handler.rfile = io.BytesIO(body)
    handler.command = "POST"
    handler.sent = []
    handler._send_json = lambda obj, code=200, extra=None: handler.sent.append((code, obj))
    return handler


class HandlerBoundaryTests(unittest.TestCase):
    def test_gzip_respects_quality_zero_and_token_boundaries(self):
        body = b"x" * preview_ui.Handler.GZIP_MIN

        disabled = make_handler(accept_encoding="br, gzip;q=0")
        substring = make_handler(accept_encoding="xgzip")
        enabled = make_handler(accept_encoding="br, gzip;q=0.5")

        self.assertFalse(disabled._gzip_ok(body, "application/json"))
        self.assertFalse(substring._gzip_ok(body, "application/json"))
        self.assertTrue(enabled._gzip_ok(body, "application/json"))

    def test_json_body_rejects_invalid_content_length(self):
        handler = make_handler(content_length="not-a-number")

        self.assertIsNone(handler._read_json_body())
        self.assertEqual(handler.sent, [(400, {"error": "Content-Length 不合法"})])

    def test_json_body_rejects_oversized_payload_before_reading(self):
        handler = make_handler(content_length=preview_ui.Handler.MAX_JSON_BODY + 1)

        self.assertIsNone(handler._read_json_body())
        self.assertEqual(handler.sent[0][0], 413)
        self.assertEqual(handler.rfile.tell(), 0)

    def test_json_body_rejects_malformed_or_non_object_json(self):
        malformed = make_handler(b"{", content_length=1)
        array = make_handler(b"[]", content_length=2)

        self.assertIsNone(malformed._read_json_body())
        self.assertEqual(malformed.sent[0][0], 400)
        self.assertIsNone(array._read_json_body())
        self.assertEqual(array.sent[0][0], 400)

    def test_json_body_accepts_empty_or_object_payload(self):
        empty = make_handler()
        body = b'{"steps": 30}'
        valid = make_handler(body, content_length=len(body))

        self.assertEqual(empty._read_json_body(), {})
        self.assertEqual(valid._read_json_body(), {"steps": 30})

    def test_head_reuses_get_route_without_writing_body(self):
        handler = make_handler()
        called = []
        handler.do_GET = lambda: called.append(True)

        preview_ui.Handler.do_HEAD(handler)

        self.assertEqual(called, [True])


class AtomicStateTests(unittest.TestCase):
    def test_only_one_concurrent_request_claims_the_same_job(self):
        old_jobs = preview_ui.STATE["jobs"]
        old_lock = preview_ui.STATE["jobs_lock"]
        preview_ui.STATE["jobs"] = {}
        preview_ui.STATE["jobs_lock"] = threading.Lock()
        try:
            barrier = threading.Barrier(8)
            results = []

            def claim():
                barrier.wait()
                results.append(preview_ui.claim_job("set/card.py", "queued", "排隊中..."))

            threads = [threading.Thread(target=claim) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(sum(claimed for claimed, _job in results), 1)
            self.assertTrue(all(job["status"] == "queued" for _claimed, job in results))
        finally:
            preview_ui.STATE["jobs"] = old_jobs
            preview_ui.STATE["jobs_lock"] = old_lock

    def test_only_one_concurrent_request_claims_a_batch(self):
        old_batch = preview_ui.STATE["batch"]
        old_lock = preview_ui.STATE["batch_lock"]
        preview_ui.STATE["batch"] = {
            "running": False, "stop": False, "total": 0,
            "done": 0, "ok": 0, "fail": 0, "running_rels": [],
        }
        preview_ui.STATE["batch_lock"] = threading.Lock()
        try:
            barrier = threading.Barrier(8)
            results = []

            def claim():
                barrier.wait()
                results.append(preview_ui.claim_batch(["a.py", "b.py"]))

            threads = [threading.Thread(target=claim) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(sum(results), 1)
            self.assertTrue(preview_ui.STATE["batch"]["running"])
            self.assertEqual(preview_ui.STATE["batch"]["total"], 2)
        finally:
            preview_ui.STATE["batch"] = old_batch
            preview_ui.STATE["batch_lock"] = old_lock

    def test_only_one_concurrent_request_claims_each_backfill(self):
        for name in ("score_backfill", "tag_backfill"):
            old_state = preview_ui.STATE[name]
            old_lock = preview_ui.STATE[f"{name}_lock"]
            preview_ui.STATE[name] = {"running": False, "done": 9, "total": 10}
            preview_ui.STATE[f"{name}_lock"] = threading.Lock()
            try:
                barrier = threading.Barrier(8)
                results = []

                def claim():
                    barrier.wait()
                    results.append(preview_ui.claim_backfill(name))

                threads = [threading.Thread(target=claim) for _ in range(8)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

                self.assertEqual(sum(results), 1, name)
                self.assertEqual(preview_ui.STATE[name], {"running": True, "done": 0, "total": 0})
            finally:
                preview_ui.STATE[name] = old_state
                preview_ui.STATE[f"{name}_lock"] = old_lock

    def test_concurrent_comfy_reconnect_waits_for_the_shared_probe(self):
        old_values = {key: preview_ui.STATE.get(key) for key in (
            "comfy_base", "comfy_pref", "comfy_last_probe")}
        old_resolve = preview_ui.resolve_comfy_base
        preview_ui.STATE.update(comfy_base=None, comfy_pref="http://example.test", comfy_last_probe=0.0)
        entered = threading.Event()
        release = threading.Event()
        calls = []
        results = []

        def resolve(pref):
            calls.append(pref)
            entered.set()
            self.assertTrue(release.wait(1))
            return "http://resolved.test"

        preview_ui.resolve_comfy_base = resolve
        try:
            first = threading.Thread(target=lambda: results.append(preview_ui.ensure_comfy_base()))
            first.start()
            self.assertTrue(entered.wait(1))
            second = threading.Thread(target=lambda: results.append(preview_ui.ensure_comfy_base()))
            second.start()
            second.join(0.05)
            self.assertTrue(second.is_alive(), "第二個呼叫應等待進行中的探測")
            release.set()
            first.join(1)
            second.join(1)

            self.assertEqual(calls, ["http://example.test"])
            self.assertEqual(results, ["http://resolved.test", "http://resolved.test"])
        finally:
            release.set()
            preview_ui.resolve_comfy_base = old_resolve
            preview_ui.STATE.update(old_values)


class CacheFreshnessTests(unittest.TestCase):
    def wait_until(self, predicate, timeout=1.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.005)
        return predicate()

    def test_background_scan_cannot_overwrite_a_new_image_update(self):
        old_scan = preview_ui._scan
        old_scan_fs = preview_ui._scan_fs
        old_bump = preview_ui.bump_libs
        entered = threading.Event()
        release = threading.Event()
        stale = {"rel": "set/card.py", "name": "card", "display_name": "card",
                 "rarity": "", "folder": "set", "has_image": False, "image_mtime": 0}
        preview_ui._scan = {
            "items": [dict(stale)], "by_rel": {stale["rel"]: dict(stale)},
            "at": 0.0, "refreshing": False,
        }
        preview_ui._scan["items"][0] = preview_ui._scan["by_rel"][stale["rel"]]

        def delayed_scan():
            entered.set()
            self.assertTrue(release.wait(1))
            return [dict(stale)]

        preview_ui._scan_fs = delayed_scan
        preview_ui.bump_libs = lambda: None
        try:
            preview_ui.scan_libraries()
            self.assertTrue(entered.wait(1))
            preview_ui._scan_note_image(stale["rel"], Path(preview_ui.__file__))
            release.set()
            self.assertTrue(self.wait_until(lambda: not preview_ui._scan["refreshing"]))

            self.assertTrue(preview_ui._scan["by_rel"][stale["rel"]]["has_image"])
        finally:
            release.set()
            self.wait_until(lambda: not preview_ui._scan.get("refreshing", False))
            preview_ui._scan = old_scan
            preview_ui._scan_fs = old_scan_fs
            preview_ui.bump_libs = old_bump

    def test_concurrent_cold_scans_share_one_filesystem_walk(self):
        old_scan = preview_ui._scan
        old_scan_fs = preview_ui._scan_fs
        old_bump = preview_ui.bump_libs
        entered = threading.Event()
        release = threading.Event()
        calls = []
        results = []
        preview_ui._scan = {"items": None, "by_rel": None, "at": 0.0,
                            "refreshing": False, "generation": 0}

        def delayed_scan():
            calls.append(True)
            entered.set()
            self.assertTrue(release.wait(1))
            return [{"rel": "set/card.py", "name": "card", "display_name": "card",
                     "rarity": "", "folder": "set", "has_image": False, "image_mtime": 0}]

        preview_ui._scan_fs = delayed_scan
        preview_ui.bump_libs = lambda: None
        try:
            first = threading.Thread(target=lambda: results.append(preview_ui.scan_libraries()))
            second = threading.Thread(target=lambda: results.append(preview_ui.scan_libraries()))
            first.start()
            self.assertTrue(entered.wait(1))
            second.start()
            second.join(0.05)
            release.set()
            first.join(1)
            second.join(1)

            self.assertEqual(len(calls), 1)
            self.assertEqual(len(results), 2)
        finally:
            release.set()
            preview_ui._scan = old_scan
            preview_ui._scan_fs = old_scan_fs
            preview_ui.bump_libs = old_bump

    def test_background_tag_index_cannot_overwrite_a_new_tag_update(self):
        old_index = preview_ui._tag_index
        old_build = preview_ui._build_tag_index
        old_parse = preview_ui.parse_lib_ast
        old_py_of = preview_ui.py_of
        entered = threading.Event()
        release = threading.Event()
        preview_ui._tag_index = {
            "by_rel": {"set/card.py": frozenset({"old"})},
            "by_tag": {"old": {"set/card.py"}},
            "at": 0.0,
            "refreshing": False,
        }

        def delayed_build():
            entered.set()
            self.assertTrue(release.wait(1))
            return ({"set/card.py": frozenset({"old"})}, {"old": {"set/card.py"}})

        preview_ui._build_tag_index = delayed_build
        preview_ui.parse_lib_ast = lambda _path: ([], [], [])
        preview_ui.py_of = lambda _rel: Path(preview_ui.__file__)
        try:
            preview_ui.get_tag_index()
            self.assertTrue(entered.wait(1))
            preview_ui._tag_index_note("set/card.py", ["new"])
            release.set()
            self.assertTrue(self.wait_until(lambda: not preview_ui._tag_index["refreshing"]))

            self.assertEqual(preview_ui._tag_index["by_rel"]["set/card.py"], frozenset({"new"}))
            self.assertEqual(preview_ui._tag_index["by_tag"].get("new"), {"set/card.py"})
        finally:
            release.set()
            self.wait_until(lambda: not preview_ui._tag_index.get("refreshing", False))
            preview_ui._tag_index = old_index
            preview_ui._build_tag_index = old_build
            preview_ui.parse_lib_ast = old_parse
            preview_ui.py_of = old_py_of

    def test_tag_search_copies_mutable_buckets_while_holding_index_lock(self):
        old_index = preview_ui._tag_index
        old_lock = preview_ui._tag_index_lock
        old_get = preview_ui.get_tag_index

        class RecordingLock:
            held = False

            def __enter__(self):
                self.held = True

            def __exit__(self, *_args):
                self.held = False

        lock = RecordingLock()

        class GuardedSet(set):
            def __iter__(self):
                self.assert_locked()
                return super().__iter__()

            def assert_locked(self):
                if not lock.held:
                    raise AssertionError('索引 bucket 在鎖外被迭代')

        by_tag = {
            "red": GuardedSet({"a.py", "b.py"}),
            "blue": GuardedSet({"b.py", "c.py"}),
        }
        preview_ui._tag_index = {"by_rel": {}, "by_tag": by_tag, "at": 1.0,
                                 "refreshing": False, "generation": 1}
        preview_ui._tag_index_lock = lock
        preview_ui.get_tag_index = lambda force=False: ({}, by_tag)
        try:
            self.assertEqual(preview_ui.search_tag_rels(["red", "blue"]), ["b.py"])
        finally:
            preview_ui._tag_index = old_index
            preview_ui._tag_index_lock = old_lock
            preview_ui.get_tag_index = old_get


class AtomicFileTests(unittest.TestCase):
    def test_atomic_write_replaces_complete_file_without_temp_residue(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "result.webp"
            dest.write_bytes(b"old")

            preview_ui.gsp.atomic_write_bytes(dest, b"new-image")

            self.assertEqual(dest.read_bytes(), b"new-image")
            self.assertEqual(list(dest.parent.glob(f".{dest.name}.*.tmp")), [])

    def test_atomic_write_preserves_old_file_and_cleans_temp_on_replace_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "result.webp"
            dest.write_bytes(b"old")

            with mock.patch.object(preview_ui.gsp.os, "replace", side_effect=OSError("disk error")):
                with self.assertRaisesRegex(OSError, "disk error"):
                    preview_ui.gsp.atomic_write_bytes(dest, b"partial-new-image")

            self.assertEqual(dest.read_bytes(), b"old")
            self.assertEqual(list(dest.parent.glob(f".{dest.name}.*.tmp")), [])


class QueueWaitTests(unittest.TestCase):
    def test_execution_error_fails_immediately_with_useful_detail(self):
        responses = [
            {"prompt_id": "p1"},
            {"p1": {
                "outputs": {},
                "status": {
                    "status_str": "error",
                    "completed": False,
                    "messages": [["execution_error", {
                        "node_id": "42",
                        "node_type": "KSampler",
                        "exception_type": "RuntimeError",
                        "exception_message": "CUDA out of memory",
                    }]],
                },
            }},
        ]

        with mock.patch.object(preview_ui.gsp, "http_json", side_effect=responses), \
             mock.patch.object(preview_ui.gsp.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "KSampler.*42.*CUDA out of memory"):
                preview_ui.gsp.queue_and_wait("http://comfy.test", {}, timeout=30)

        sleep.assert_not_called()

    def test_success_without_persistent_images_does_not_wait_for_timeout(self):
        responses = [
            {"prompt_id": "p1"},
            {"p1": {
                "outputs": {"9": {"images": [
                    {"filename": "preview.png", "type": "temp"},
                ]}},
                "status": {"status_str": "success", "completed": True, "messages": []},
            }},
        ]

        with mock.patch.object(preview_ui.gsp, "http_json", side_effect=responses), \
             mock.patch.object(preview_ui.gsp.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "沒有可儲存的輸出圖片"):
                preview_ui.gsp.queue_and_wait("http://comfy.test", {}, timeout=30)

        sleep.assert_not_called()


class PlatformProbeTests(unittest.TestCase):
    def test_text_subprocess_probes_replace_undecodable_system_output(self):
        calls = []

        def run(*args, **kwargs):
            calls.append(kwargs)
            return mock.Mock(stdout="100.64.0.1\n")

        with mock.patch.object(subprocess, "run", side_effect=run), \
             mock.patch.object(preview_ui.gsp, "http_json", return_value={}):
            preview_ui.gsp.resolve_comfy_base("http://127.0.0.1:8188")

        with mock.patch.object(subprocess, "run", side_effect=run), \
             mock.patch.object(preview_ui.shutil, "which", return_value="tailscale.exe"):
            self.assertEqual(preview_ui.get_tailscale_ip(), "100.64.0.1")

        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(all(call.get("errors") == "replace" for call in calls))


if __name__ == "__main__":
    unittest.main()

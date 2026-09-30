"""Regression tests for legacy output rows; no network or Telegram credentials."""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


def load_t_bot():
    log_module = types.ModuleType("utils.log_utils")
    log_module.LogUtils = Mock()
    dependencies = {
        "requests": Mock(),
        "telegram": Mock(),
        "utils.log_utils": log_module,
    }
    spec = importlib.util.spec_from_file_location(
        "t_bot", Path(__file__).resolve().parents[1] / "src" / "T-Bot.py"
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, dependencies):
        spec.loader.exec_module(module)
    return module


t_bot = load_t_bot()
MISSING = object()


def media(filename, tweet_id=MISSING, **overrides):
    item = {
        "file_name": filename,
        "user": {"screen_name": "example", "name": "Example"},
        "media_type": "images",
        "url": f"https://example.invalid/{filename}",
        "publish_time": "2026-09-30T00:00:00",
        "is_downloaded": False,
        "is_uploaded": False,
        "upload_info": {},
    }
    if tweet_id is not MISSING:
        item["tweet_id"] = tweet_id
    item.update(overrides)
    return item


class LegacyOutputTests(unittest.TestCase):
    def process(self, items):
        downloads, singles, groups = [], [], []

        def download(item, processor):
            downloads.append(item["file_name"])
            item["is_downloaded"] = True

        def single(manager, item, processor):
            singles.append(item["file_name"])
            manager._update_upload_status(item, 123)

        def group(manager, group_items, processor):
            groups.append([item["file_name"] for item in group_items])
            for item in group_items:
                manager._update_upload_status(item, 456)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.json"
            output.write_text(json.dumps(items), encoding="utf-8")
            with (
                patch.object(t_bot.UploadManager, "_initialize_bot"),
                patch.object(t_bot.DownloadManager, "process_item", side_effect=download),
                patch.object(t_bot.UploadManager, "_upload_media_item", single),
                patch.object(t_bot.UploadManager, "_handle_media_group", group),
            ):
                t_bot.process_single(str(output), str(Path(directory) / "downloads"))
            saved = json.loads(output.read_text(encoding="utf-8"))
        return saved, downloads, singles, groups

    def test_missing_and_empty_ids_upload_independently_without_invented_ids(self):
        items = [
            media("missing-a.jpg"),
            media("missing-b.jpg"),
            media("empty-a.jpg", ""),
            media("empty-b.jpg", ""),
            media("null.jpg", None),
        ]
        saved, downloads, singles, groups = self.process(items)
        filenames = [item["file_name"] for item in items]
        self.assertEqual(downloads, filenames)
        self.assertEqual(singles, filenames)
        self.assertEqual(groups, [])
        self.assertTrue(all(item["is_uploaded"] for item in saved))
        self.assertNotIn("tweet_id", saved[0])
        self.assertNotIn("tweet_id", saved[1])
        self.assertEqual(saved[2]["tweet_id"], "")
        self.assertEqual(saved[3]["tweet_id"], "")
        self.assertIsNone(saved[4]["tweet_id"])
        saved_again, downloads, singles, groups = self.process(saved)
        self.assertEqual((downloads, singles, groups), ([], [], []))
        self.assertEqual(saved_again, saved)

    def test_uploaded_rows_are_preserved_without_redownload_or_resend(self):
        status = {"success": True, "message_id": 789, "timestamp": "2026-09-20T00:00:00"}
        items = [
            media("legacy.jpg", is_uploaded=True, upload_info=copy.deepcopy(status)),
            media("empty.jpg", "", is_uploaded=True, upload_info=copy.deepcopy(status)),
            media("current.jpg", "123", is_uploaded=True, upload_info=copy.deepcopy(status)),
        ]
        saved, downloads, singles, groups = self.process(items)
        self.assertEqual((downloads, singles, groups), ([], [], []))
        self.assertEqual(saved, items)

    def test_valid_tweet_ids_keep_album_and_single_strategies(self):
        items = [media("a.jpg", "123"), media("b.jpg", "123"), media("c.jpg", "456")]
        saved, downloads, singles, groups = self.process(items)
        self.assertEqual(downloads, ["a.jpg", "b.jpg", "c.jpg"])
        self.assertEqual(groups, [["a.jpg", "b.jpg"]])
        self.assertEqual(singles, ["c.jpg"])
        self.assertTrue(all(item["is_uploaded"] for item in saved))

    def test_terminal_upload_errors_are_preserved_without_redownload(self):
        error = {
            "success": False,
            "error_type": "file_too_large",
            "message": "Video exceeds 50 MB",
            "notification_sent": True,
        }
        items = [
            media("legacy.mp4", media_type="videos", upload_info=copy.deepcopy(error)),
            media("current.mp4", "123", media_type="videos", upload_info=copy.deepcopy(error)),
        ]
        saved, downloads, singles, groups = self.process(items)
        self.assertEqual((downloads, singles, groups), ([], [], []))
        self.assertEqual(saved, items)

    def test_api_errors_remain_retriable_for_legacy_and_current_rows(self):
        error = {"success": False, "error_type": "api_error", "message": "Temporary timeout"}
        items = [
            media("legacy.jpg", upload_info=copy.deepcopy(error)),
            media("current.jpg", "123", upload_info=copy.deepcopy(error)),
        ]
        saved, downloads, singles, groups = self.process(items)
        self.assertEqual(downloads, ["legacy.jpg", "current.jpg"])
        self.assertEqual(singles, ["legacy.jpg", "current.jpg"])
        self.assertEqual(groups, [])
        self.assertTrue(all(item["is_uploaded"] for item in saved))


if __name__ == "__main__":
    unittest.main()

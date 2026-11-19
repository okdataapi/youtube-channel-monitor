"""Runs monitor.py against a local mock of the okdata API with canned answers. No network, no real key.

The fixtures in tests/fixtures are shared with tests/monitor.test.mjs, so both versions must write the same CSVs,
the same transcript files and print the same report."""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
os.environ["NO_PROXY"] = "*"

import monitor as tool  # noqa: E402
from mock_okdata import TEST_KEY, MockOkdata, error, ok  # noqa: E402

API = json.loads((FIXTURES / "api.json").read_text(encoding="utf-8"))
MOON = "UCMoonLabSpaceChannel123"
ARGS = ["--channel", "@TrailKit", "--channel", f"https://www.youtube.com/channel/{MOON}/videos", "--videos", "2"]
CHANNEL_PATH = "/v1/youtube/channels/get"
LIST_PATH = "/v1/youtube/channels/videos/list"
VIDEO_PATH = "/v1/youtube/videos/get"
TRANSCRIPT_PATH = "/v1/youtube/videos/transcript/get"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class MonitorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.run_index = 0
        self.api = MockOkdata({CHANNEL_PATH: self.channel_page, LIST_PATH: self.list_page,
                               VIDEO_PATH: self.video_page, TRANSCRIPT_PATH: self.transcript_page})
        tool.API = self.api.url
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "data"

    def tearDown(self) -> None:
        self.api.close()
        self.tmp.cleanup()

    def channel_page(self, query: dict) -> tuple:
        item = API["runs"][self.run_index]["channels"].get(query.get("username") or query.get("id"))
        return (200, ok("youtube.channels.get", item=item)) if item else (404, error("not_found"))

    def list_page(self, query: dict) -> tuple:
        pages = API["runs"][self.run_index]["lists"].get(query.get("username") or query.get("id")) or [[]]
        index = int(query.get("cursor") or 0)
        more = str(index + 1) if index + 1 < len(pages) else None
        return 200, ok("youtube.channels.videos.list", items=pages[index], next_cursor=more)

    def video_page(self, query: dict) -> tuple:
        item = API["runs"][self.run_index]["videos"].get(query["id"])
        return (200, ok("youtube.videos.get", item=item)) if item else (404, error("not_found"))

    def transcript_page(self, query: dict) -> tuple:
        item = API["transcripts"].get(query["id"])
        return (200, ok("youtube.videos.transcript.get", item=item, amount="0.004")) if item else (
            404, error("not_found"))

    def run_tool(self, *argv: str, key: str = TEST_KEY, run: int = 0) -> tuple:
        self.run_index = run
        os.environ["OKDATA_API_KEY"] = key
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = tool.main([*argv, "--out", str(self.out)], now=lambda: API["runs"][run]["run_at"])
        return code, out.getvalue(), err.getvalue()

    def csv_text(self, name: str) -> str:
        return (self.out / name).read_text(encoding="utf-8")

    def test_two_runs_append_both_csvs_save_transcripts_and_report(self) -> None:
        code, out, log = self.run_tool(*ARGS, "--transcripts", "1", run=0)
        self.assertEqual(code, 0, log)
        self.assertIn("(first run)", out)
        self.assertIn("spent $0.02", log)  # 2 x (profile + list + 2 videos) at $0.002, 1 transcript at $0.004
        code, out, log = self.run_tool(*ARGS, "--transcripts", "1", run=1)
        self.assertEqual(code, 0, log)
        self.assertEqual(self.csv_text("channels.csv"), fixture("expected-channels.csv"))
        self.assertEqual(self.csv_text("videos.csv"), fixture("expected-videos.csv"))
        self.assertEqual(out, fixture("expected-report.txt"))
        saved = sorted(p.name for p in (self.out / "transcripts").iterdir())
        self.assertEqual(saved, ["trail000002.txt", "trail000003.txt"])  # the newest new upload of each run
        transcript = (self.out / "transcripts" / "trail000002.txt").read_bytes().decode("utf-8")
        self.assertEqual(transcript, fixture("expected-transcript.txt"))
        calls = self.api.paid()
        profiles = [c["query"] for c in calls if c["path"] == CHANNEL_PATH]
        self.assertEqual(profiles[0], {"username": "trailkit", "view": "full"})
        self.assertEqual(profiles[1], {"id": MOON, "view": "full"})
        self.assertTrue(all(c["query"]["view"] == "brief" for c in calls if c["path"] == LIST_PATH))
        self.assertEqual(len([c for c in calls if c["path"] == VIDEO_PATH]), 8)

    def test_csv_rows_are_clipped_and_safe_for_spreadsheets(self) -> None:
        self.run_tool(*ARGS, run=0)
        rows = list(csv.DictReader(io.StringIO(self.csv_text("videos.csv"))))
        self.assertEqual([r["video_id"] for r in rows], ["trail000002", "trail000001", "moon0000002", "moon0000001"])
        self.assertTrue(rows[1]["title"].startswith("'=HYPERLINK"))
        self.assertEqual(rows[1]["comments"], "")  # a hidden count stays empty, not 0
        long = rows[2]["title"]  # no title, so the description stands in, on one line
        self.assertLessEqual(len(long), 200)
        self.assertTrue(long.endswith("…"))
        self.assertNotIn("\n", long)
        self.assertEqual(rows[3]["duration_s"], "5")  # sent as 5.0

    def test_dry_run_needs_no_key_and_spends_nothing(self) -> None:
        self.api.prices = {"youtube.channels.get": "0.002", "youtube.channels.videos.list": "0.002",
                           "youtube.videos.get": "0.003", "youtube.videos.transcript.get": "0.004"}
        code, _, log = self.run_tool(*ARGS, "--transcripts", "1", "--dry-run", key="")
        self.assertEqual(code, 0)
        self.assertIn("+ up to 1 transcript(s) = up to 9 call(s); at most $0.024", log)
        self.assertEqual(self.api.paid(), [])
        self.assertFalse(self.out.exists())

    def test_budget_and_missing_key_stop_before_any_call(self) -> None:
        code, _, log = self.run_tool(*ARGS, "--transcripts", "1", "--budget", "0.01")
        self.assertEqual(code, 3)
        self.assertIn("at most $0.02", log)
        code, _, log = self.run_tool(*ARGS, key="")
        self.assertEqual(code, 2)
        self.assertIn("signup/?src=gh-youtube-channel-monitor", log)
        self.assertEqual(self.api.paid(), [])

    def test_failed_channel_totals_keep_the_videos_and_every_charged_attempt_counts(self) -> None:
        failed = {**error("upstream_failed", retry="yes"), "charged": True, "amount": "0.002"}
        self.api.routes[CHANNEL_PATH] = lambda q: (502, failed) if q.get("id") else self.channel_page(q)
        code, out, log = self.run_tool(*ARGS)
        self.assertEqual(code, 4, log)
        self.assertIn(f"{MOON}: channel totals: upstream_failed: scripted (charged: yes).", log)
        self.assertIn(f"  {MOON}  no channel totals this run", out)
        self.assertIn(f"{MOON}: 2 videos", log)
        self.assertEqual(len([c for c in self.api.paid() if c["path"] == CHANNEL_PATH]), 4)  # 1 + 3 attempts
        self.assertIn("spent $0.02", log)  # 0.008 per channel + 3 charged attempts at 0.002

    def test_a_failed_video_is_skipped_and_the_rest_saved(self) -> None:
        self.api.routes[VIDEO_PATH] = lambda q: (404, error("not_found")) if q["id"] == "trail000001" else (
            self.video_page(q))
        code, _, log = self.run_tool(*ARGS)
        self.assertEqual(code, 4, log)
        self.assertIn("@trailkit: video trail000001: not_found: scripted (charged: no). Check the channel", log)
        self.assertIn("@trailkit: 1 videos", log)
        self.assertEqual(self.csv_text("videos.csv").count("\n"), 4)  # header + 3 videos

    def test_a_lost_answer_is_retried_with_the_same_idempotency_key(self) -> None:
        answers = [(503, error("upstream_busy", retry="yes"))]
        self.api.routes[CHANNEL_PATH] = lambda q: answers.pop() if answers else self.channel_page(q)
        code, _, log = self.run_tool("--channel", "trailkit", "--videos", "1")
        self.assertEqual(code, 0, log)
        first, second = self.api.paid()[:2]
        self.assertEqual(first["headers"]["idempotency-key"], second["headers"]["idempotency-key"])
        self.assertIn("@trailkit: 1 videos", log)

    def test_the_budget_is_also_checked_before_every_call(self) -> None:
        def pricey(q: dict) -> tuple:
            status, body = self.video_page(q)
            body["meta"]["billing"]["amount"] = "0.004"  # more than the catalog said
            return status, body
        self.api.routes[VIDEO_PATH] = pricey
        code, out, log = self.run_tool(*ARGS, "--budget", "0.016")
        self.assertEqual(code, 1, log)
        self.assertIn(f"{MOON}: video moon0000002: budget_reached", log)
        self.assertIn("spent $0.016", log)
        self.assertIn("Trail Kit · 182,000 subscribers", out)  # what was paid for is saved and reported

    def test_appends_cleanly_to_a_file_without_a_final_newline(self) -> None:
        self.run_tool(*ARGS, "--transcripts", "1", run=0)
        for name in ("channels.csv", "videos.csv"):
            path = self.out / name
            path.write_text(path.read_text(encoding="utf-8").rstrip("\n"), encoding="utf-8")
        self.run_tool(*ARGS, "--transcripts", "1", run=1)
        self.assertEqual(self.csv_text("channels.csv"), fixture("expected-channels.csv"))
        self.assertEqual(self.csv_text("videos.csv"), fixture("expected-videos.csv"))

    def test_a_wrong_key_stops_the_run_and_writes_nothing(self) -> None:
        code, out, log = self.run_tool(*ARGS, key="okd_wrong")
        self.assertEqual(code, 1)
        self.assertIn("@trailkit: channel totals: unauthorized", log)
        self.assertEqual(out, "")
        self.assertEqual(len(self.api.paid()), 1)  # nothing else was tried
        self.assertFalse((self.out / "videos.csv").exists())

    def test_refuses_a_csv_with_other_columns_before_spending(self) -> None:
        self.out.mkdir()
        (self.out / "videos.csv").write_text("date,name\n2026-01-01,x\n", encoding="utf-8")
        code, _, log = self.run_tool(*ARGS)
        self.assertEqual(code, 1)
        self.assertIn("other columns", log)
        self.assertEqual(self.api.paid(), [])

    def test_a_saved_transcript_is_not_bought_again(self) -> None:
        folder = self.out / "transcripts"
        folder.mkdir(parents=True)
        (folder / "trail000002.txt").write_text("mine", encoding="utf-8")
        code, _, log = self.run_tool(*ARGS, "--transcripts", "1")
        self.assertEqual(code, 0, log)
        self.assertEqual((folder / "trail000002.txt").read_text(encoding="utf-8"), "mine")
        self.assertIn("This month we built a landing pad.", (folder / "moon0000002.txt").read_text(encoding="utf-8"))
        self.assertEqual([c["query"]["id"] for c in self.api.paid() if c["path"] == TRANSCRIPT_PATH],
                         ["moon0000002"])

    def test_more_than_one_list_page_when_asked_for_many_videos(self) -> None:
        ids = [f"vid{n:08d}" for n in range(45)]
        self.api.routes[LIST_PATH] = lambda q: (200, ok("l", items=[{"id": i} for i in (
            ids[30:] if q.get("cursor") else ids[:30])], next_cursor=None if q.get("cursor") else "p2"))
        self.api.routes[VIDEO_PATH] = lambda q: (200, ok("v", item={"id": q["id"], "url": f"u/{q['id']}",
                                                                     "title": "t", "metrics": {"views": 1}}))
        code, _, log = self.run_tool("--channel", "@trailkit", "--videos", "31", "--budget", "1")
        self.assertEqual(code, 0, log)
        self.assertEqual([c["query"].get("cursor") for c in self.api.paid() if c["path"] == LIST_PATH], [None, "p2"])
        self.assertIn("@trailkit: 31 videos", log)

    def test_odd_answers_become_empty_cells_the_same_way_in_both_versions(self) -> None:
        self.api.routes[LIST_PATH] = lambda q: (200, ok("l", items=[None, {"id": 5}, "x", {"id": "-dashfirst1"}]))
        self.api.routes[VIDEO_PATH] = lambda q: (200, ok("v", item={
            "id": q["id"], "url": ["not", "text"], "title": {"a": 1}, "text": "=1+1", "published_at": True,
            "metrics": "lots", "ext": [1]}))
        code, _, log = self.run_tool("--channel", "@trailkit", "--videos", "3")
        self.assertEqual(code, 0, log)
        self.assertEqual(self.csv_text("videos.csv").splitlines()[1],
                         "2026-11-18T08:00:00Z,trailkit,'-dashfirst1,,'=1+1,,,,,")

    def test_an_id_that_starts_with_a_dash_reads_back_as_written(self) -> None:
        self.api.routes[LIST_PATH] = lambda q: (200, ok("l", items=[{"id": "-dashfirst1"}]))
        self.api.routes[VIDEO_PATH] = lambda q: (200, ok("v", item={"id": q["id"], "url": "u", "title": "t",
                                                                     "metrics": {"views": 1}}))
        self.run_tool("--channel", "@trailkit", "--videos", "1", run=0)
        code, out, log = self.run_tool("--channel", "@trailkit", "--videos", "1", run=1)
        self.assertEqual(code, 0, log)
        self.assertIn("New uploads since the last run: 0\n", out)
        self.assertIn(",'-dashfirst1,", self.csv_text("videos.csv"))  # still safe to open in a spreadsheet

    def test_calls_whose_answers_were_lost_count_against_the_budget(self) -> None:
        self.api.routes[VIDEO_PATH] = lambda q: (502, "not json") if q["id"] == "trail000002" else self.video_page(q)
        code, _, log = self.run_tool("--channel", "@trailkit", "--videos", "2")
        self.assertEqual(code, 4, log)
        self.assertIn("(charged: unknown)", log)
        self.assertIn("spent $0.006 (and up to $0.002 more on calls whose answers were lost)", log)


class HelpersTest(unittest.TestCase):
    def test_handles_ids_and_links_are_normalised(self) -> None:
        self.assertEqual(tool.channel("@NASA"), "nasa")
        self.assertEqual(tool.channel(" NASA "), "nasa")
        self.assertEqual(tool.channel("https://www.youtube.com/@NASA/videos?si=abc"), "nasa")
        self.assertEqual(tool.channel("youtube.com/@%E4%B8%AD%E6%96%87"), "中文")
        self.assertEqual(tool.channel("UCLA_DiR1FfKNvjuUpBHmylQ"), "UCLA_DiR1FfKNvjuUpBHmylQ")
        self.assertEqual(tool.channel("https://m.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/featured"),
                         "UCLA_DiR1FfKNvjuUpBHmylQ")
        for bad in ("", "@", "two words", "-start", "@=cmd", "youtube.com/@nasa%0A", "https://www.youtube.com/c/NASA", "https://www.youtube.com/user/NASA",
                    "https://www.youtube.com/channel/nope", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"):
            with self.assertRaises(Exception, msg=bad):
                tool.channel(bad)

    def test_clip_counts_characters_not_bytes(self) -> None:
        self.assertEqual(tool.clip("a\n\tb  c", 10), "a b c")
        self.assertEqual(tool.clip("🔥" * 10, 5), "🔥🔥🔥🔥…")
        self.assertEqual(tool.clip(None, 5), "")

    def test_money_and_percent_formatting(self) -> None:
        self.assertEqual(tool.usd(Decimal("0.002") * 10), "0.02")
        self.assertEqual(tool.usd(Decimal("0.50")), "0.5")
        self.assertEqual(tool.usd(Decimal("0")), "0")
        self.assertEqual(tool.growth_percent(500, 1000), " (+50.0%)")
        self.assertEqual(tool.growth_percent(1, 3), " (+33.3%)")
        self.assertEqual(tool.growth_percent(1, 8), " (+12.5%)")  # 12.5 exactly, no float rounding
        self.assertEqual(tool.growth_percent(5, 0), "")
        self.assertEqual(tool.growth_percent(252, 1206371), " (<0.1%)")
        self.assertEqual(tool.dollars("1e-8"), Decimal("0.00000001"))
        self.assertIsNone(tool.dollars("-1"))

    def test_the_report_compares_the_right_runs(self) -> None:
        def video(run_at: str, vid: str, views: str, channel: str = "a") -> dict:
            return {"run_at": run_at, "channel": channel, "video_id": vid, "url": f"u{vid}", "title": "",
                    "published_at": "", "duration_s": "", "views": views, "likes": "", "comments": ""}

        def totals(run_at: str, subscribers: str) -> dict:
            return {"run_at": run_at, "channel": "a", "channel_id": "UC1", "name": "A", "subscribers": subscribers,
                    "videos": "", "views": ""}
        day = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]
        videos = [video(day[0], "1", "10"), video(day[1], "1", "100"), video(day[1], "2", "5"),
                  video(day[2], "1", "130"), video(day[2], "2", "905"), video(day[2], "3", "1"),
                  video(day[2], "4", "2"), video(day[2], "9", "7", channel="b")]
        text = tool.report([totals(day[0], "1000"), totals(day[2], "1500")], videos, top=1)
        self.assertIn(f"(previous run {day[1]})", text)
        self.assertIn("  @a  A · 1,500 subscribers (+500) · ? videos · ? views\n", text)  # vs its last earlier row
        self.assertIn("  @b  no channel totals this run · first snapshot\n", text)
        self.assertIn("New uploads since the last run: 2\n  2 views · @a · posted ?\n", text)  # not @b's video
        self.assertIn("  ...and 1 more in the CSV", text)
        self.assertIn("+900 views (+18000.0%) · @a · 905 now", text)
        self.assertNotIn("+30 views", text)  # --top 1 keeps only the biggest mover
        self.assertNotIn("+120 views", text)  # growth is measured against the previous run, not the first


if __name__ == "__main__":
    unittest.main()

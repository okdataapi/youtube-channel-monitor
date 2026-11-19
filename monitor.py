#!/usr/bin/env python3
"""Monitor YouTube channels over time.

Each run records, for every channel you name, its subscriber, video and view totals (one row per channel in
<out>/channels.csv) and its newest videos with their views, likes and comments (one row per video in
<out>/videos.csv), then prints a short report: the uploads that are new since the last run, the videos that gained
the most views, and how each channel's totals moved. Run it every day from cron or GitHub Actions and the two CSVs
become a time series you can chart. With --transcripts N it also saves the transcripts of the newest new uploads
as text files, ready to summarise with an LLM.

Data comes from the okdata API (https://okdata.online/?src=gh-youtube-channel-monitor), $0.002 per call.
Python 3.9+, standard library only. The key goes in the OKDATA_API_KEY environment variable.

    python3 monitor.py --channel @NASA --channel @TED
    python3 monitor.py --channel https://www.youtube.com/@NASA --videos 20 --transcripts 2 --dry-run
"""
from __future__ import annotations

import argparse
import csv
import http.client
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple, TypeVar
from urllib.error import HTTPError
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen

VERSION = "0.1.0"
SOURCE = "gh-youtube-channel-monitor"
SIGN_UP = f"https://okdata.online/signup/?src={SOURCE}"
CONSOLE = f"https://okdata.online/console/?src={SOURCE}"
API = os.environ.get("OKDATA_BASE_URL", "https://api.okdata.online").rstrip("/")
CHANNEL = "youtube.channels.get"
CHANNEL_VIDEOS = "youtube.channels.videos.list"
VIDEO = "youtube.videos.get"
TRANSCRIPT = "youtube.videos.transcript.get"
# Fallback prices (USD) if the free catalog cannot be read; the live catalog wins.
PRICES = {CHANNEL: Decimal("0.002"), CHANNEL_VIDEOS: Decimal("0.002"), VIDEO: Decimal("0.002"),
          TRANSCRIPT: Decimal("0.004")}
LIST_PAGE = 30  # videos on one page of a channel's video list
CHANNEL_FIELDS = ["run_at", "channel", "channel_id", "name", "subscribers", "videos", "views"]
VIDEO_FIELDS = ["run_at", "channel", "video_id", "url", "title", "published_at", "duration_s", "views", "likes",
                "comments"]
CHANNELS_CSV = "channels.csv"
VIDEOS_CSV = "videos.csv"
TRANSCRIPTS_DIR = "transcripts"
TITLE_LIMIT = 200  # characters kept in the CSV
CAPTION_LIMIT = 60  # characters shown in the report
# Errors that every later call would hit too, so the run stops instead of trying the next channel.
STOP_CODES = {"unauthorized", "insufficient_balance", "key_budget_exceeded", "cost_cap_exceeded", "key_scope_denied",
              "account_suspended", "budget_reached"}
RETRY_STATUSES = {429, 500, 502, 503, 504}
# Spelled out (not \s) so Python and Node collapse exactly the same characters.
WHITESPACE = re.compile("[\t\n\v\f\r \u00a0\u2028\u2029]+")
CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
# A handle: no spaces or URL punctuation, and no first character a spreadsheet would read as a formula.
HANDLE = re.compile("^(?![-=+])[^\t\n\v\f\r \u00a0\u2028\u2029/?#&%@:,;\"'<>\\\\]{1,100}$")
CHANNEL_URL = re.compile(r"youtube\.com/(@[^/?#]+|channel/[^/?#]*|c/|user/)", re.IGNORECASE)
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")  # a YouTube video id; ids that look different are skipped
INTEGER = re.compile(r"-?[0-9]+")
AMOUNT = re.compile(r"[0-9]+(\.[0-9]+)?")
AMOUNT_FROM_API = re.compile(r"[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?")
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
MAX_SAFE_INTEGER = 2 ** 53 - 1  # the largest count Node can hold exactly

Channel = Tuple[str, Dict[str, str]]  # (key in the CSVs: handle or channel ID, the parameter that names it)
Row = Dict[str, Any]
T = TypeVar("T")


class ApiError(Exception):
    def __init__(self, code: str, message: str, *, charged: Optional[bool] = False, retry: str = "no",
                 retry_after: Optional[float] = None, amount: Any = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code, self.charged, self.retry, self.retry_after = code, charged, retry, retry_after
        self.amount = amount


class OutputError(Exception):
    """A CSV cannot be used: other columns, or not a writable file."""


class Stop(Exception):
    """An error every later call would hit too (bad key, low balance, --budget)."""


class Okdata:
    """The okdata calls this script needs, with safe retries and a hard spending cap."""

    def __init__(self, key: Optional[str], budget: Optional[Decimal] = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.key = key
        self.budget = budget
        self.sleep = sleep
        self.spent = Decimal("0")
        self.held = Decimal("0")  # calls whose answer was lost, counted at their price when checking the budget
        self.caps = dict(PRICES)

    def _headers(self, idempotency_key: Optional[str]) -> Dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": f"{SOURCE}/{VERSION} (python)"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def prices(self) -> Dict[str, Decimal]:
        """Current prices from the free catalog (no key needed); the built-in table if it cannot be read."""
        try:
            data = request_json(f"{API}/v1/catalog", self._headers(None), self.sleep)["data"]
            live = {e["id"]: dollars(e.get("maxCharge")) for e in data["endpoints"]}
            self.caps = {k: live.get(k) or v for k, v in PRICES.items()}
        except (ApiError, KeyError, TypeError, AttributeError):
            self.caps = dict(PRICES)
        return self.caps

    def _afford(self, cap: Decimal, charged: bool = False) -> None:
        if self.budget is not None and self.spent + self.held + cap > self.budget:
            raise ApiError("budget_reached", f"the next call could cost ${usd(cap)} and pass the --budget of "
                                             f"${usd(self.budget)}", charged=charged)

    def call(self, endpoint: str, **params: Any) -> Dict[str, Any]:
        cap = self.caps.get(endpoint, Decimal("0"))
        self._afford(cap)
        query = urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{API}/v1/{endpoint.replace('.', '/')}?{query}"

        def paid(amount: Any) -> None:  # keep the spend in step with what the API reports
            reported = dollars(amount)
            self.spent += cap if reported is None else reported

        def on_charge(amount: Any, again: bool) -> None:
            paid(amount)
            if again:
                self._afford(cap, charged=True)

        try:
            body = request_json(url, self._headers(str(uuid.uuid4())), self.sleep, on_charge)
        except ApiError as err:
            if err.charged is None:
                self.held += cap
            raise
        paid(as_dict(as_dict(body.get("meta")).get("billing")).get("amount"))
        return body


def _http_error(exc: HTTPError) -> ApiError:
    try:
        body = json.loads(exc.read().decode("utf-8"))
    except (ValueError, OSError, http.client.HTTPException):  # not JSON, or the body was cut off
        body = None
    if isinstance(body, dict) and "code" in body:
        return ApiError(str(body["code"]), str(body.get("message") or ""), charged=body.get("charged", False),
                        retry=str(body.get("retry") or "no"), retry_after=body.get("retry_after_seconds"),
                        amount=body.get("amount"))
    return ApiError(f"http_{exc.code}", str(exc.reason), charged=None,
                    retry="yes" if exc.code in RETRY_STATUSES else "no")


def request_json(url: str, headers: Dict[str, str], sleep: Callable[[float], None] = time.sleep,
                 on_charge: Optional[Callable[[Any, bool], None]] = None) -> Dict[str, Any]:
    """GET with up to 2 retries that reuse the same Idempotency-Key, so a lost answer is replayed instead of run
    twice. After a lost answer the call may still be running on the server, so a rate_limited reply is waited out.
    on_charge hears about every attempt the API says it charged, retried ones too, and may raise to stop."""
    retries, waits, ambiguous, paid = 0, 0, False, False
    while True:
        try:
            with urlopen(Request(url, headers=headers), timeout=90) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            if isinstance(body, dict) and body.get("code") == "ok":
                return body
            err = (ApiError(str(body.get("code")), str(body.get("message") or "")) if isinstance(body, dict)
                   else ApiError("bad_response", "unexpected answer", charged=None, retry="same_key"))
        except HTTPError as exc:
            err = _http_error(exc)
        except (OSError, ValueError, http.client.HTTPException) as exc:  # network, timeout, cut-off or non-JSON
            err = ApiError("connection_error", str(exc), charged=None, retry="same_key")
        ambiguous = ambiguous or err.charged is None
        if ambiguous and err.code == "rate_limited" and waits < 5:
            waits += 1
            sleep(_wait(err.retry_after, 1.0))
            continue
        again = err.retry in ("yes", "same_key") and retries < 2
        if err.charged is True:
            paid = True
            if on_charge:
                on_charge(err.amount, again)
        if not again:
            if ambiguous and err.charged is False:
                err.charged = None  # an earlier attempt may still finish
            if paid:
                err.charged = True  # an earlier attempt was charged
            raise err
        sleep(_wait(err.retry_after, 2.0 ** retries))
        retries += 1


def _wait(value: Any, default: float) -> float:
    """Seconds to sleep: the server's hint if it is a sane number, capped at 30."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return default
    return min(max(seconds, 0.0), 30.0)


def use_utf8() -> None:
    """Emoji and non-Latin titles in and out, also on Windows consoles and pipes."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace" if stream is sys.stderr else "strict")


def dollars(value: Any) -> Optional[Decimal]:
    """An amount from the API ("0.002", 0.002 or 1e-8) as a Decimal; None if it is not a sane amount."""
    if isinstance(value, bool) or not AMOUNT_FROM_API.fullmatch(str(value).strip()):
        return None
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        return None
    return amount if amount.is_finite() and amount >= 0 else None


def usd(amount: Decimal) -> str:
    """0.020 -> "0.02", 1.50 -> "1.5"; the same text the Node version prints."""
    return format(amount.normalize(), "f")


def charged(err: ApiError) -> str:
    return {True: "yes", False: "no"}.get(err.charged, "unknown")  # type: ignore[arg-type]


def cell(value: Any) -> Any:
    """Text that starts like a spreadsheet formula gets a leading ' so Excel shows it instead of running it."""
    return "'" + value if isinstance(value, str) and value[:1] in FORMULA_START else value


def uncell(value: str) -> str:
    """The text cell() was given back, so ids such as -abc… read back as they were written."""
    return value[1:] if value[:1] == "'" and value[1:2] in FORMULA_START else value


def as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def plain(text: Any) -> str:
    """Text as Node would write it: a lone UTF-16 surrogate becomes U+FFFD; anything but text is empty."""
    return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace") if isinstance(text, str) else ""


def clip(text: Any, limit: int) -> str:
    """One line, at most `limit` characters, with … where it was cut."""
    line = WHITESPACE.sub(" ", plain(text)).strip(" ")
    return line if len(line) <= limit else line[: limit - 1].rstrip(" ") + "…"


def whole(value: Any) -> Any:
    """A count as Node writes it: a whole number (5.0 becomes 5) or a string of digits; anything else is empty."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return value if abs(value) <= MAX_SAFE_INTEGER else None
    return value if isinstance(value, str) and INTEGER.fullmatch(value) else None


def text_of(value: Any) -> Optional[str]:
    """A short text field (link, time, id) on one line; empty when it is not text."""
    return clip(value, 1000) or None


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(line: str) -> None:
    print(line, file=sys.stderr)


# --- what to monitor ---------------------------------------------------------------------------------------------

def channel(value: str) -> str:
    """'@NASA', 'NASA', a UC… channel ID or a channel link -> 'nasa' or the channel ID."""
    text = value.strip()
    found = CHANNEL_URL.search(text)
    if found:
        path = found.group(1)
        if path[:1] != "@" and not path.lower().startswith("channel/"):
            raise argparse.ArgumentTypeError(f"use the channel's @handle or its UC… ID instead of: {value!r}")
        text = path if path[:1] == "@" else path[len("channel/"):]
        try:
            text = unquote(text, errors="strict")
        except UnicodeDecodeError:
            pass  # the % left in the text makes it fail below
        if path[:1] != "@" and not CHANNEL_ID.fullmatch(text):
            raise argparse.ArgumentTypeError(f"not a channel ID in this link: {value!r}")
    if CHANNEL_ID.fullmatch(text):
        return text
    handle = text[1:] if text[:1] == "@" else text
    if not HANDLE.fullmatch(handle):
        raise argparse.ArgumentTypeError(f"not a YouTube handle, channel ID or channel link: {value!r}")
    return handle.lower()


def shown(key: str) -> str:
    """How a channel is shown in the log and the report: @handle, or the channel ID."""
    return key if CHANNEL_ID.fullmatch(key) else "@" + key


def plan_channels(keys: List[str]) -> List[Channel]:
    unique: Dict[str, Channel] = {}
    for key in keys:
        unique.setdefault(key, (key, {"id": key} if CHANNEL_ID.fullmatch(key) else {"username": key}))
    return list(unique.values())


def list_pages(videos: int) -> int:
    return -(-videos // LIST_PAGE)


def plan_cost(caps: Dict[str, Decimal], channels: int, videos: int, transcripts: int) -> Decimal:
    each = caps[CHANNEL] + caps[CHANNEL_VIDEOS] * list_pages(videos) + caps[VIDEO] * videos
    return each * channels + caps[TRANSCRIPT] * transcripts


# --- fetching ----------------------------------------------------------------------------------------------------

def fetch(ok: Okdata, endpoint: str, cached: List[str], **params: Any) -> Dict[str, Any]:
    """One call. When the answer is a copy the API fetched a little earlier (meta.cached), its fetch time goes
    into `cached`."""
    body = ok.call(endpoint, **params)
    meta = as_dict(body.get("meta"))
    if meta.get("cached"):
        cached.append(str(meta.get("fetched_at") or "?"))
    return body


def item_of(body: Dict[str, Any]) -> Dict[str, Any]:
    return as_dict(as_dict(body.get("data")).get("item"))


def channel_row(ok: Okdata, run_at: str, key: str, params: Dict[str, str], cached: List[str]) -> Row:
    item = item_of(fetch(ok, CHANNEL, cached, **params, view="full"))
    return {
        "run_at": run_at,
        "channel": key,
        "channel_id": text_of(item.get("id")),
        "name": clip(item.get("name"), TITLE_LIMIT),
        "subscribers": whole(item.get("followers")),
        "videos": whole(item.get("posts")),
        "views": whole(as_dict(item.get("ext")).get("views")),
    }


def newest_ids(ok: Okdata, params: Dict[str, str], newest: int, cached: List[str]) -> List[str]:
    """The ids of the channel's `newest` newest videos (its list is newest first)."""
    ids: List[str] = []
    cursor = None
    for _ in range(list_pages(newest)):
        body = fetch(ok, CHANNEL_VIDEOS, cached, **params, cursor=cursor, view="brief")
        for item in as_list(as_dict(body.get("data")).get("items")):
            video_id = as_dict(item).get("id")
            if isinstance(video_id, str) and VIDEO_ID.fullmatch(video_id) and video_id not in ids:
                ids.append(video_id)
        cursor = as_dict(body.get("page")).get("next_cursor")
        cursor = cursor if isinstance(cursor, str) and cursor else None
        if len(ids) >= newest or not cursor:
            break
    return ids[:newest]


def video_row(ok: Okdata, run_at: str, key: str, video_id: str, cached: List[str]) -> Row:
    item = item_of(fetch(ok, VIDEO, cached, id=video_id, view="full"))
    metrics = as_dict(item.get("metrics"))
    return {
        "run_at": run_at,
        "channel": key,
        "video_id": video_id,
        "url": text_of(item.get("url")),
        "title": clip(plain(item.get("title")) or item.get("text"), TITLE_LIMIT),
        "published_at": text_of(item.get("published_at")),
        "duration_s": whole(as_dict(item.get("ext")).get("length_s")),
        **{k: whole(metrics.get(k)) for k in ("views", "likes", "comments")},
    }


def transcript_text(row: Dict[str, Any], item: Dict[str, Any]) -> str:
    """A transcript file: what the video is, then the words, one caption line per line, spaces tidied."""
    lines = (WHITESPACE.sub(" ", line).strip(" ") for line in plain(item.get("text")).split("\n"))
    words = "\n".join(line for line in lines if line)
    if not words:
        return ""
    about = [plain(row.get("title")), plain(row.get("url")),
             f"{shown(row['channel'])} · published {row.get('published_at') or '?'} · "
             f"transcript language {plain(item.get('lang')) or '?'}"]
    return "\n".join(about) + "\n\n" + words + "\n"


# --- storing -----------------------------------------------------------------------------------------------------

def read_rows(path: Path, fields: List[str]) -> List[Dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(newline="", encoding="utf-8-sig") as f:  # -sig: also reads a file a spreadsheet saved
        reader = csv.DictReader(f, restval="")
        if reader.fieldnames != fields:
            raise OutputError(f"{path} has other columns than this monitor writes; use another --out")
        return [{k: uncell(v) if isinstance(v, str) else v for k, v in row.items()} for row in reader]


def check_writable(path: Path, folder: bool = False) -> None:
    """Fail before any paid call if a file could not be written afterwards."""
    (path if folder else path.parent).mkdir(parents=True, exist_ok=True)
    if path.exists() and path.is_dir() != folder:
        raise OutputError(f"{path} is not a {'folder' if folder else 'file'}")
    if not os.access(path if path.exists() else path.parent, os.W_OK):
        raise OutputError(f"{path} is not writable")


def ends_with_newline(path: Path) -> bool:
    with path.open("rb") as f:
        f.seek(-1, os.SEEK_END)
        return f.read(1) in (b"\n", b"\r")


def append_rows(path: Path, fields: List[str], rows: List[Row]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = not path.exists() or path.stat().st_size == 0
    newline_first = not fresh and not ends_with_newline(path)  # a file saved without a final newline
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        if newline_first:
            f.write("\n")
        if fresh:
            writer.writeheader()
        writer.writerows({k: cell(v) for k, v in row.items()} for row in rows)


# --- the report --------------------------------------------------------------------------------------------------

def number(value: Any) -> Optional[int]:
    return int(value) if value is not None and INTEGER.fullmatch(str(value)) else None


def count(value: Optional[int]) -> str:
    return "?" if value is None else f"{value:,}"


def change(now: Optional[int], before: Optional[int]) -> str:
    if now is None or before is None:
        return ""
    return f" ({'+' if now >= before else '-'}{abs(now - before):,})"


def growth_percent(growth: int, before: int) -> str:
    """Integer maths, rounded half up, so Python and Node print the same digits."""
    if before <= 0:
        return ""
    tenths = (growth * 1000 + before // 2) // before
    return f" (+{tenths // 10}.{tenths % 10}%)" if tenths else " (<0.1%)"


def first_by_video(rows: Iterable[Dict[str, str]]) -> Dict[str, Dict[str, str]]:
    found: Dict[str, Dict[str, str]] = {}
    for row in rows:
        found.setdefault(row["video_id"], row)
    return found


def channel_lines(channels: List[Dict[str, str]], videos: List[Dict[str, str]], current: str) -> List[str]:
    """One line per channel in the latest run: its totals and how they moved since its last earlier row."""
    keys = list(dict.fromkeys(r["channel"] for r in channels + videos if r["run_at"] == current))
    width = max(len(shown(key)) for key in keys)
    later_run = any(r["run_at"] < current for r in channels + videos)
    lines = []
    for key in keys:
        mine = [r for r in channels if r["channel"] == key]
        now = next((r for r in mine if r["run_at"] == current), None)
        before = next((r for r in reversed(mine) if r["run_at"] < current), None)
        known = before or any(r["channel"] == key and r["run_at"] < current for r in videos)
        name = (now or before or {}).get("name", "")
        if now is None:
            totals = ["no channel totals this run"]
        else:
            totals = [f"{count(number(now[k]))} {k}{change(number(now[k]), number(before[k]) if before else None)}"
                      for k in ("subscribers", "videos", "views")]
        parts = [name, *totals, "first snapshot" if later_run and not known else ""]
        lines.append(f"  {shown(key).ljust(width)}  " + " · ".join(p for p in parts if p))
    return lines


def video_lines(lead: str, row: Dict[str, str], who: str, extra: str) -> List[str]:
    parts = [lead, who, extra, clip(row["title"], CAPTION_LIMIT)]
    return ["  " + " · ".join(p for p in parts if p), f"    {row['url']}"]


def report(channels: List[Dict[str, str]], videos: List[Dict[str, str]], top: int) -> str:
    """Channel totals, new uploads in the latest run, and the biggest view gains between the last two runs."""
    runs = sorted({r["run_at"] for r in channels + videos})
    if not runs:
        return ""
    current = runs[-1]
    previous = runs[-2] if len(runs) > 1 else None
    lines = [f"YouTube monitor run {current} " + (f"(previous run {previous})" if previous else "(first run)")]
    lines += channel_lines(channels, videos, current)
    if previous is None:
        lines += ["", "First snapshot saved. Run again later to see new uploads, the biggest movers and how the "
                      "totals change."]
        return "\n".join(lines) + "\n"

    names = {r["channel"]: r["name"] for r in channels if r["name"]}

    def who(r: Dict[str, str]) -> str:  # @handle, or a channel ID by its name when known
        return names.get(r["channel"], r["channel"]) if CHANNEL_ID.fullmatch(r["channel"]) else shown(r["channel"])

    latest = first_by_video(r for r in videos if r["run_at"] == current)
    earlier = [r for r in videos if r["run_at"] < current]
    seen = {r["video_id"] for r in earlier}
    known = {r["channel"] for r in earlier}
    fresh = sorted((r for r in latest.values() if r["video_id"] not in seen and r["channel"] in known),
                   key=lambda r: (-(number(r["views"]) or 0), r["video_id"]))
    lines += ["", f"New uploads since the last run: {len(fresh)}"]
    for r in fresh[:top]:
        lines += video_lines(f"{count(number(r['views']))} views", r, who(r),
                             f"posted {(r['published_at'] or '?')[:10]}")
    if len(fresh) > top:
        lines.append(f"  ...and {len(fresh) - top} more in the CSV")

    before = first_by_video(r for r in videos if r["run_at"] == previous)
    movers = []
    for r in latest.values():
        after = number(r["views"])
        old = number(before[r["video_id"]]["views"]) if r["video_id"] in before else None
        if after is not None and old is not None and after > old:
            movers.append((after - old, old, after, r))
    movers.sort(key=lambda m: (-m[0], m[3]["video_id"]))
    lines += ["", "Biggest movers by views since the last run:"]
    if not movers:
        lines.append("  No video gained views between the last two runs.")
    for growth, old, after, r in movers[:top]:
        lines += video_lines(f"+{growth:,} views{growth_percent(growth, old)}", r, who(r), f"{after:,} now")
    return "\n".join(lines) + "\n"


# --- the command -------------------------------------------------------------------------------------------------

def hint(code: str) -> str:
    return {
        "unauthorized": f"Check OKDATA_API_KEY, or get a key at {SIGN_UP}",
        "insufficient_balance": f"Top up at {CONSOLE} and run again.",
        "key_budget_exceeded": f"This key reached the spending limit set for it at {CONSOLE}",
        "budget_reached": "Stopped at --budget.",
        "cost_cap_exceeded": "The account reached its daily spending allowance; it resets at the next UTC day.",
        "not_found": "Check the channel handle or ID.",
    }.get(code, "")


def attempt(what: str, step: Callable[[], T], tally: Dict[str, int]) -> Optional[T]:
    """Run one step; on an API error log it and carry on, or raise Stop when every later call would fail too."""
    try:
        return step()
    except ApiError as err:
        tally["failed"] += 1
        log(f"{what}: {err} (charged: {charged(err)}). {hint(err.code)}".rstrip())
        if err.code in STOP_CODES:
            raise Stop() from err
        return None


def monitor_channel(ok: Okdata, run_at: str, chan: Channel, newest: int, out: Path,
                    tally: Dict[str, int]) -> List[Row]:
    """One channel: its totals, then its newest videos. Each row is saved as soon as it is in, so a failure later
    in the run (or Ctrl-C) keeps what was paid for."""
    key, params = chan
    label = shown(key)
    cached: List[str] = []
    totals = attempt(f"{label}: channel totals", lambda: channel_row(ok, run_at, key, params, cached), tally)
    if totals:
        append_rows(out / CHANNELS_CSV, CHANNEL_FIELDS, [totals])
        tally["saved"] += 1
    # Only the calls that bring counts go into the "counts as of" note, not the list of ids.
    ids = attempt(f"{label}: video list", lambda: newest_ids(ok, params, newest, []), tally) or []
    rows: List[Row] = []
    for video_id in ids:
        row = attempt(f"{label}: video {video_id}", lambda v=video_id: video_row(ok, run_at, key, v, cached), tally)
        if row:
            append_rows(out / VIDEOS_CSV, VIDEO_FIELDS, [row])
            tally["saved"] += 1
            rows.append(row)
    note = f" (counts as of {min(cached)})" if cached else ""
    log(f"{label}: {len(rows)} videos{note}")
    return rows


def save_transcripts(ok: Okdata, rows: List[Row], seen: Set[str], limit: int, folder: Path,
                     tally: Dict[str, int]) -> None:
    """Transcripts of the `limit` newest videos this run saw for the first time, one text file each."""
    fresh = sorted((r for r in rows if r["video_id"] not in seen), key=lambda r: r["video_id"])
    fresh.sort(key=lambda r: str(r.get("published_at") or ""), reverse=True)
    calls = 0
    for row in fresh:
        if calls == limit:
            return
        video_id = row["video_id"]
        path = folder / f"{video_id}.txt"
        if not VIDEO_ID.fullmatch(video_id) or path.exists():  # never turn odd text into a file name
            continue
        calls += 1
        item = attempt(f"transcript {video_id}", lambda: item_of(fetch(ok, TRANSCRIPT, [], id=video_id)), tally)
        if item is None:
            continue
        text = transcript_text(row, item)
        if not text:
            log(f"transcript {video_id}: the video has no transcript text")
            continue
        with path.open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        log(f"saved {path}")


def print_plan(args: argparse.Namespace, channels: List[Channel], caps: Dict[str, Decimal], most: Decimal) -> None:
    pages = list_pages(args.videos)
    calls = len(channels) * (1 + pages + args.videos) + args.transcripts
    extra = f" + up to {args.transcripts} transcript(s)" if args.transcripts else ""
    out = Path(args.out)
    log(f"plan: {len(channels)} channel(s) x (1 profile + {pages} list page(s) + up to {args.videos} video(s))"
        f"{extra} = up to {calls} call(s); at most ${usd(most)}")
    for key, _ in channels:
        log(f"  {shown(key)}")
    prices = (f"  {CHANNEL} ${usd(caps[CHANNEL])}, {CHANNEL_VIDEOS} ${usd(caps[CHANNEL_VIDEOS])} per page, "
              f"{VIDEO} ${usd(caps[VIDEO])} per video")
    log(prices + (f", {TRANSCRIPT} ${usd(caps[TRANSCRIPT])} per transcript" if args.transcripts else ""))
    log(f"  appends to {out / CHANNELS_CSV} and {out / VIDEOS_CSV}"
        + (f"; transcripts go to {out / TRANSCRIPTS_DIR}" if args.transcripts else ""))


def run(args: argparse.Namespace, ok: Okdata, now: Callable[[], str]) -> int:
    channels = plan_channels(args.channel)
    most = plan_cost(ok.prices(), len(channels), args.videos, args.transcripts)
    print_plan(args, channels, ok.caps, most)
    if args.dry_run:
        return 0
    if most > args.budget:
        log(f"over the --budget of ${usd(args.budget)}; raise it or use fewer --videos")
        return 3
    if not ok.key:
        log(f"OKDATA_API_KEY is not set. Get a key at {SIGN_UP}")
        return 2

    out = Path(args.out)
    read_rows(out / CHANNELS_CSV, CHANNEL_FIELDS)  # refuse a foreign or unwritable CSV before spending anything
    seen = {r["video_id"] for r in read_rows(out / VIDEOS_CSV, VIDEO_FIELDS)}
    for name in (CHANNELS_CSV, VIDEOS_CSV):
        check_writable(out / name)
    if args.transcripts:
        check_writable(out / TRANSCRIPTS_DIR, folder=True)
    run_at = now()
    tally = {"saved": 0, "failed": 0}
    stopped = False
    rows: List[Row] = []
    try:
        for chan in channels:
            rows += monitor_channel(ok, run_at, chan, args.videos, out, tally)
        if args.transcripts:
            save_transcripts(ok, rows, seen, args.transcripts, out / TRANSCRIPTS_DIR, tally)
    except Stop:
        stopped = True
    if tally["saved"]:
        log(f"appended {tally['saved']} rows to {out / CHANNELS_CSV} and {out / VIDEOS_CSV}")
        sys.stdout.write(report(read_rows(out / CHANNELS_CSV, CHANNEL_FIELDS),
                                read_rows(out / VIDEOS_CSV, VIDEO_FIELDS), args.top))
    lost = f" (and up to ${usd(ok.held)} more on calls whose answers were lost)" if ok.held else ""
    log(f"spent ${usd(ok.spent)}{lost}")
    if stopped or (tally["failed"] and not tally["saved"]):
        return 1
    return 4 if tally["failed"] else 0


def money(value: str) -> Decimal:
    if not AMOUNT.fullmatch(value.strip()):
        raise argparse.ArgumentTypeError(f"not an amount in USD: {value!r}")
    return Decimal(value.strip())


def whole_number(minimum: int) -> Callable[[str], int]:
    def parse(value: str) -> int:
        if not re.fullmatch(r"[0-9]+", value.strip()) or int(value) < minimum:
            raise argparse.ArgumentTypeError(f"must be {minimum} or more")
        return int(value)
    return parse


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        allow_abbrev=False,
        description="Monitor YouTube channels: append their totals and their newest videos' counts to two CSVs, "
                    "then report new uploads, the biggest movers and subscriber changes (okdata API, $0.002 per "
                    "call).")
    p.add_argument("--channel", action="append", type=channel, metavar="CHANNEL",
                   help="a handle (@NASA), a channel ID (UC…) or a channel link (repeat for more)")
    p.add_argument("--videos", type=whole_number(1), default=10, metavar="N",
                   help="newest videos to record per channel, one call each (default 10)")
    p.add_argument("--transcripts", type=whole_number(0), default=0, metavar="N",
                   help="save the transcripts of the N newest new uploads to <out>/transcripts (default 0)")
    p.add_argument("--out", default="data", metavar="DIR", help="folder for the CSVs (default data)")
    p.add_argument("--top", type=whole_number(1), default=5, metavar="N",
                   help="how many new uploads and movers to list (default 5)")
    p.add_argument("--budget", type=money, default=Decimal("0.5"), metavar="USD",
                   help="refuse runs that could cost more (USD, default 0.5)")
    p.add_argument("--dry-run", action="store_true", help="print the plan and the most it can cost, then stop")
    args = p.parse_args(argv)
    if not args.channel:
        p.error("give at least one --channel")
    return args


def main(argv: Optional[List[str]] = None, now: Callable[[], str] = utc_now) -> int:
    use_utf8()
    args = parse_args(argv)
    ok = Okdata(os.environ.get("OKDATA_API_KEY", "").strip() or None, budget=args.budget)
    try:
        return run(args, ok, now)
    except (OutputError, OSError) as err:
        log(f"error: {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

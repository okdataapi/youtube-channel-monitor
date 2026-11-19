# youtube-channel-monitor: track YouTube channels and their new videos over time

Watch a handful of YouTube channels (a competitor, a partner, your own): every run records each channel's
subscribers, video count and total views, plus its newest videos' views, likes and comments, then tells you what was
uploaded since last time, which videos are taking off, and how each channel's numbers moved.

One Python file (standard library only) and one Node file (no dependencies), same flags, same CSVs. Run it by hand,
from cron, or let the included GitHub Action take a snapshot every day and commit the CSVs. No YouTube login: the
data comes from the [okdata](https://okdata.online/?src=gh-youtube-channel-monitor) API at $0.002 per call.

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/okdataapi/youtube-channel-monitor/blob/main/youtube_monitor.ipynb)
Try it in the browser first: the notebook asks for your key, takes a snapshot, then shows the channels, their newest
videos and a chart.

Good for: keeping an eye on a competitor's uploads and how they land, comparing your channel with partners', spotting
which new video is breaking out, or collecting the transcripts of new uploads to summarise with an LLM.

## What you get

The real report from the second of two runs 67 minutes apart (progress lines on stderr left out):

```console
$ node monitor.mjs --channel @NASA --channel @natgeo --channel @TED --videos 5
YouTube monitor run 2026-11-19T22:07:23Z (previous run 2026-11-19T21:00:36Z)
  @nasa    NASA · 15,100,000 subscribers (+0) · 6,204 videos (+0) · 1,136,489,313 views (+0)
  @natgeo  National Geographic · 26,600,000 subscribers (+0) · 11,594 videos (+0) · 7,311,145,000 views (+0)
  @ted     TED · 28,000,000 subscribers (+0) · 5,901 videos (+0) · 3,284,281,278 views (+0)

New uploads since the last run: 0

Biggest movers by views since the last run:
  +23,803 views (+84.2%) · @ted · 52,071 now · How We’ll Actually Ditch Fossil Fuels — by the Numbers | Mi…
    https://www.youtube.com/watch?v=ACCnhY1fKoI
  +3,324 views (+1.8%) · @ted · 189,338 now · How to Rewire Your Brain — and Find Your Flow | Heather Ber…
    https://www.youtube.com/watch?v=B2SIsncgFi0
  +1,987 views (+0.4%) · @natgeo · 542,166 now · Unearthing Egypt's Pyramids | Lost Treasures of Egypt MEGA…
    https://www.youtube.com/watch?v=zW1Kmr8O7is
  +1,637 views (+11.3%) · @natgeo · 16,102 now · How Muscle Cars Reshaped American History (Full Episode) |…
    https://www.youtube.com/watch?v=EGGu_mSU1F4
  +1,017 views (+0.5%) · @ted · 202,585 now · The Science of Learning New Things | Tania Lombrozo | TED
    https://www.youtube.com/watch?v=4qxROUatTzk
```

The channel totals read `+0` because they come from a copy that is refreshed every few hours; video counts are at
most an hour old, so a daily run sees both move. Each run made 21 calls (3 channel profiles, 3 video lists, 15
videos) and cost $0.042. Every run appends one row per channel to `data/channels.csv`:

```csv
run_at,channel,channel_id,name,subscribers,videos,views
2026-11-19T21:00:36Z,nasa,UCLA_DiR1FfKNvjuUpBHmylQ,NASA,15100000,6204,1136489313
2026-11-19T21:00:36Z,ted,UCAuUUnT6oDeKwE6v1NGQxug,TED,28000000,5901,3284281278
```

and one row per video to `data/videos.csv` (NASA has comments turned off, so `comments` is empty):

```csv
run_at,channel,video_id,url,title,published_at,duration_s,views,likes,comments
2026-11-19T21:00:36Z,nasa,61S764A-TKo,https://www.youtube.com/watch?v=61S764A-TKo,Apply to Become A NASA Astronaut,2026-11-07T17:50:03.000Z,64,432513,11099,
2026-11-19T21:00:36Z,ted,ACCnhY1fKoI,https://www.youtube.com/watch?v=ACCnhY1fKoI,How We’ll Actually Ditch Fossil Fuels — by the Numbers | Michael Liebreich | TED,2026-11-19T16:00:15.000Z,661,28268,639,113
2026-11-19T22:07:23Z,nasa,61S764A-TKo,https://www.youtube.com/watch?v=61S764A-TKo,Apply to Become A NASA Astronaut,2026-11-07T17:50:03.000Z,64,432717,11100,
2026-11-19T22:07:23Z,ted,ACCnhY1fKoI,https://www.youtube.com/watch?v=ACCnhY1fKoI,How We’ll Actually Ditch Fossil Fuels — by the Numbers | Michael Liebreich | TED,2026-11-19T16:00:15.000Z,661,52071,824,143
```

Open them in a spreadsheet, or load them with pandas and pivot on `video_id` and `run_at` to chart each video's
growth, or on `channel` and `run_at` to chart subscribers.

## Quick start

1. Get an API key at [okdata.online](https://okdata.online/signup/?src=gh-youtube-channel-monitor). Pay per call, no subscription.
2. Put it in your environment and run either version:

```bash
git clone https://github.com/okdataapi/youtube-channel-monitor
cd youtube-channel-monitor
export OKDATA_API_KEY=okd_...     # keep it out of code and commits

# see the plan and the most it can cost first (no key needed)
python3 monitor.py --channel @NASA --channel @natgeo --channel @TED --dry-run

# Python 3.9+
python3 monitor.py --channel @NASA --channel @natgeo --channel @TED

# or Node 18+
node monitor.mjs --channel @NASA --channel @natgeo --channel @TED
```

The first run saves a baseline. Run it again later (in an hour, or tomorrow) and the report lists new uploads, the
biggest movers and how each channel's totals changed. Both versions read and write the same CSVs, so you can switch
between them.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--channel CHANNEL` | | A channel to watch: a handle (`@NASA` or `NASA`), a channel ID (`UCLA_DiR1FfKNvjuUpBHmylQ`) or a channel link (`https://www.youtube.com/@NASA`, `https://www.youtube.com/channel/UC…`). Repeat for more. |
| `--videos N` | `10` | How many of each channel's newest videos to record. Each video is one call. |
| `--transcripts N` | `0` | Also save the transcripts of the N newest videos this run sees for the first time (see below). |
| `--out DIR` | `data` | Folder for `channels.csv`, `videos.csv` and `transcripts/`. The CSVs are only ever appended to. |
| `--top N` | `5` | How many new uploads and movers the report lists. |
| `--budget USD` | `0.5` | Refuse to start if the run could cost more than this. |
| `--dry-run` | | Print the plan and the most it can cost, then stop. Needs no key. |

Old-style links (`/c/name`, `/user/name`) are refused: use the channel's `@handle` or its `UC…` ID instead (both
are on the channel's About page).

The report goes to stdout; progress and the amount spent go to stderr. Rows are saved channel by channel, so a
failure halfway keeps what was already fetched.

| Exit code | Meaning |
|---|---|
| `0` | Done |
| `1` | Stopped by an error that would hit every call (bad key, low balance, `--budget` reached), or nothing could be fetched |
| `2` | No key, or a bad flag |
| `3` | The plan could cost more than `--budget`; nothing was called |
| `4` | Done, but some calls failed (a channel's totals, a video or a transcript); everything else was saved |

### The CSVs

`channels.csv`, one row per channel per run:

| Column | |
|---|---|
| `run_at` | When the run started, UTC. Every row of one run has the same value. |
| `channel` | The channel as you named it: its handle (without `@`) or its channel ID |
| `channel_id` | The channel's `UC…` ID |
| `name` | The channel's name |
| `subscribers` | Subscribers, rounded the way YouTube shows them (`15.1M` is written as `15100000`) |
| `videos` | Number of videos on the channel |
| `views` | Total views of all the channel's videos |

`videos.csv`, one row per video per run:

| Column | |
|---|---|
| `run_at` | Same as above |
| `channel` | Which channel it belongs to, as in `channels.csv` |
| `video_id`, `url` | The video |
| `title` | The title on one line, cut to 200 characters |
| `published_at` | When it was published, ISO 8601 UTC |
| `duration_s` | Length in seconds |
| `views`, `likes`, `comments` | Exact counts at the time of the run; empty when YouTube does not show one (`comments` is empty for a video with comments turned off, as on NASA's) |

The videos are the newest ones on each channel's Videos tab (Shorts are not included), newest first. "New uploads"
are videos in the latest run that were in no earlier run, from channels that were already watched before: a channel's
first run is its baseline. "Movers" are the videos found in both of the last two runs, ranked by how many views they
gained. Each channel's line compares its totals with its last earlier row. Text that starts like a spreadsheet
formula (`=`, `+`, `-`, `@`) gets a leading `'` so Excel shows it instead of running it.

Run it once a day, or every few hours. Two runs close together can come back with the same numbers: when the API
answers from a copy it fetched earlier, the log line for that channel ends with `(counts as of <time>)`. Video counts
can come from a copy up to about an hour old and channel totals from one a few hours old, so a daily run always sees
fresh numbers.

### Transcripts

With `--transcripts N`, the run ends by fetching the transcripts of the N newest videos it saw for the first time (on
a first run, simply the newest videos) and saves each one as `transcripts/<video_id>.txt` in the `--out` folder. A
transcript that is already on disk is not fetched again. Each file starts with what the video is, then the words,
one caption line per line, ready to paste into an LLM ("summarise this talk in five bullet points"):

```text
How We’ll Actually Ditch Fossil Fuels — by the Numbers | Michael Liebreich | TED
https://www.youtube.com/watch?v=ACCnhY1fKoI
@ted · published 2026-11-19T16:00:15.000Z · transcript language en

So,
you may have heard
that the clean energy transition has
failed,
and that we should be pragmatic,
which means accepting our almost
…
```

## Endpoints and prices

| What | Endpoint | Price |
|---|---|---|
| A channel's subscribers, video count and total views | [`youtube.channels.get`](https://okdata.online/apis/youtube/channels/get/?src=gh-youtube-channel-monitor) | $0.002 per channel |
| A channel's newest videos, about 30 a page | [`youtube.channels.videos.list`](https://okdata.online/apis/youtube/channels/videos/list/?src=gh-youtube-channel-monitor) | $0.002 per page |
| One video's exact views, likes and comments | [`youtube.videos.get`](https://okdata.online/apis/youtube/videos/get/?src=gh-youtube-channel-monitor) | $0.002 per video |
| One transcript (only with `--transcripts`) | [`youtube.videos.transcript.get`](https://okdata.online/apis/youtube/videos/transcript/get/?src=gh-youtube-channel-monitor) | $0.004 |

The video list shows counts the way YouTube rounds them ("75K views") and no likes, so each recorded video gets its
own call for exact numbers; `--videos` sets how many. Three channels with the default 10 videos each, once a day:
36 calls, $0.072 a day, about $2.20 a month. With `--videos 5` it is 21 calls, $0.042 a day. Before calling anything,
the script reads the current prices from the public catalog (`GET https://api.okdata.online/v1/catalog`, no key
needed), prints the most the run can cost and refuses runs over `--budget`; it checks the budget again before every
call. Full price list: [prices.json](https://github.com/okdataapi/okdata/blob/main/docs/prices.json).

## Scheduling

### cron

Keep the key in a file only you can read, for example `~/.okdata.env` containing `export OKDATA_API_KEY=okd_...`
(`chmod 600 ~/.okdata.env`), then `crontab -e`:

```cron
# every day at 07:00
0 7 * * * cd "$HOME/youtube-channel-monitor" && . "$HOME/.okdata.env" && python3 monitor.py --channel @NASA --channel @natgeo --channel @TED >> "$HOME/youtube-monitor.log" 2>&1
```

Swap in `node monitor.mjs` if you prefer Node; give the full path to `python3` or `node` if cron cannot find it.

### GitHub Actions

[`.github/workflows/monitor.yml`](.github/workflows/monitor.yml) takes a snapshot every day at 06:23 UTC and commits
`data/` (both CSVs and any transcripts) back to the repository, so the history builds up in git.

1. Fork this repository (or use it as a template).
2. Add your key under **Settings → Secrets and variables → Actions → New repository secret**, named `OKDATA_API_KEY`.
3. Under the **Variables** tab, set `CHANNELS` (space-separated handles, IDs or links, e.g. `@NASA @TED`), and
   optionally `VIDEOS` (default 10) and `TRANSCRIPTS` (default 0). Without `CHANNELS` it watches `@NASA`, `@natgeo`
   and `@TED`.
4. Open the **Actions** tab, enable workflows if GitHub asks (forks start with them off), then
   **monitor → Run workflow** to take the first snapshot now.

The report shows up on each run's summary page. When some calls fail (exit code 4) the run shows a warning instead
of failing and still commits what it got. Without the `OKDATA_API_KEY` secret the workflow skips quietly. The data
is committed to your repository, so make the repository private if the list of channels you watch is nobody else's
business. To run the Node version, replace `python monitor.py` with `node monitor.mjs` in the workflow.

## Use it from an AI client

The scripts above are plain REST clients. The same YouTube endpoints are also available to AI assistants through
okdata's remote MCP server, `https://api.okdata.online/mcp`, so you can ask things like "what did @NASA upload this
month and how many views did each video get?" or "summarise the transcript of the newest @TED talk".

Claude Code:

```bash
claude mcp add --transport http okdata https://api.okdata.online/mcp --header 'Authorization: Bearer ${OKDATA_API_KEY}'
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "okdata": {
      "url": "https://api.okdata.online/mcp",
      "headers": {
        "Authorization": "Bearer ${env:OKDATA_API_KEY}"
      }
    }
  }
}
```

Dify: install the [okdata plugin](https://marketplace.dify.ai/plugin/okdata/okdata) from the Dify Marketplace,
then authorize it with your key.

## Notes

- A sample project by [okdata](https://okdata.online/?src=gh-youtube-channel-monitor), not affiliated with YouTube
  or Google. The scripts only call the okdata API.
- Public channels and public counts only. Use the data to study content and trends, not to build profiles of people.
- Tests: `python3 -m unittest discover -s tests` and `node --test tests/monitor.test.mjs`. They run against a
  local mock server (no network, no cost) and check both versions against the same expected CSVs, transcript and
  report.
- Issues and ideas are welcome.

## License

MIT, see [LICENSE](LICENSE).

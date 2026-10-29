# eh.

Installable PWA for e-value.net's **Complete Pending Evaluations**. Every pending evaluation
(faculty, rotation, procedure) shows as a card. Tap a vibe and the whole form comes back filled in.
Glance at it, then send.

**App:** https://eh.robbiemed.org (GitHub Pages, repo `robbie-med/eh`, root, `CNAME`)
**Proxy:** https://eh-api.robbiemed.org (Hetzner VPS, `proxy/app.py`)

## How it fills a form

- **Vibes:** 🤩 Loved it · 🙂 Good · 😐 Fine · 🤷 Never met (faculty only: every rating N/A, every
  required comment a flat "did not work with Dr. X" line).
- **Ratings** stay positive and need no comment: always at or above "meets expectations", so they're never
  below the program's low-score threshold (which makes e-value demand a comment), and never the top box
  of a 7+ point scale. Each evaluation gets one "mood" and each rating varies a little around it.
- **Comments** are generic boilerplate in the short annual-rating style, built from a small grammar
  (`{a|b}` picks one), so no two read alike. 🎲 rewrites one comment, the 🎲 in the header rewrites everything.
  Confidential boxes are always left blank. Any box can be typed over.
- **Non-rating questions:** "% of time on rotation" is always 100%. "Just right" and "Further supervision
  required" are picked when offered. Anything else uses your last answer to that question, or is
  highlighted for one tap.
- **Send:** *Save draft* = e-value's Save For Later (still editable). *Submit* needs two taps.
  It's final, and e-value may email people.

## Architecture

```
PWA (GitHub Pages) ──► VPS nginx ──► proxy/app.py :8104 ──SOCKS5 over Nebula──► home PC ──► www.e-value.net
```

e-value's Cloudflare bans datacenter IPs, so traffic exits through the same home-PC SOCKS proxy as
ev-quicklog and duty-hours (`EV_SOCKS_PROXY`).

## e-value evaluation API (from HAR, Oct 2026)

- List: `index.cfm?fuseaction=users_evalmodules&menu=19&accessid=2`. One grey header table per activity
  (Activity/Site/Period/Time Frame), then rows whose *Edit Evaluation* link carries
  `requestid, eimnum, name, updateableid`.
- Open: `index.cfm?fuseaction=users_getevaleimnum&requestid=&eimnum=&name=&accessid=2&updateableid=`
  (a frameset), then the form frame `users/dsp_evaltest.cfm?view=0&accessid=2&eimnum=&diffList=&requestid=&path=`.
- Form `answerform`: questions split on `<a name="Question_N">`. The header `(Question N of M - Mandatory)`
  or `, Confidential`. Fields are named `answer_<eimnum>_<questionId>`. The question ID is stable across forms.
  Radios and selects call `recordAnswer(qtype, name, theanswer, next, lowscore, scale, override)`, and textareas
  call `recordEssay(...)`. qtypes seen: 1 multiple choice, 4 select scale, 11 radio scale, 3 essay, 16 date.
  0-9 scales use 0 = "Insufficient contact / N/A".
- Autosave as you answer: GET `users/hid_storeanswer.cfm?activityid&moduleid&eimnum&questionname&qtype&theanswer&answer&essay=&lowscore&thescale&popuprule=1&calcdest=0`
  (`activityid`/`moduleid` come from the page's `HiddenEssay` form). The reply contains an alert about the
  "low score threshold" when a rating needs a comment. Essays: POST `users/hid_storeessay.cfm`
  `essay, questionname, activityid, moduleid, eimnum`.
- Close: POST `index.cfm` `fuseaction=users_closemodule, requestid, eimnum, path, lastAddedQ, scrolloption,
  answer_* (+ answer_*_date hidden), HidSFL, Action` with `Action=Submit` or `Action=Save For Later`
  (`HidSFL=Save For Later`). The 302 `Location` carries `message=`: "Thank you for completing this evaluation."
  / "Your answers have been saved…" / "Alert… mandatory questions unanswered" (bounced back to the form).
- The proxy repeats the browser exactly: re-reads the form, autosaves each answer, then closes. Its POST
  bodies were checked field-for-field against the HAR captures.

## Deploy

```bash
# VPS, once
sudo mkdir -p /opt/eh-proxy && sudo chown robbie:robbie /opt/eh-proxy
python3 -m venv /opt/eh-proxy/venv && /opt/eh-proxy/venv/bin/pip install requests pysocks
scp -i ~/.ssh/tododuk_hetzner proxy/app.py robbie@157.180.87.209:/opt/eh-proxy/app.py
# install proxy/eh-proxy.service (set EV_SOCKS_PROXY) and proxy/eh-api.nginx.conf,
# add DNS A record eh-api → 157.180.87.209 (grey cloud), then:
sudo certbot --nginx -d eh-api.robbiemed.org
sudo systemctl enable --now eh-proxy
```

PWA deploy = push to `main` with Pages serving the repo root.

## Local development

```bash
python proxy/app.py                          # 127.0.0.1:8104 (this PC's home egress works)
python -m http.server 8105 --bind 127.0.0.1  # http://localhost:8105
```

In Settings, set Proxy URL to `http://localhost:8104`.

## Security

- Credentials live only in the browser's localStorage and are sent to the proxy at login.
- `proxy/data/` holds live e-value session cookies (8 h TTL) and is gitignored. HTTP request logging is off.
- `*.har` captures contain credentials and cookies; never commit them.
- Never test Submit programmatically: it's irreversible and e-value may email people. Read-only calls
  (login, `/evals`, `/form`) are safe.

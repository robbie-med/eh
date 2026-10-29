#!/usr/bin/env python3
"""
meh-value proxy — tiny CORS proxy in front of www.e-value.net's "Complete Pending
Evaluations" for the meh-value PWA. Holds e-value session cookies server-side
(JSON files on disk), keyed by a random session token issued at /login.
Contains no secrets.

Endpoints (JSON; everything except /login and /ping needs X-Session):
  POST /login  {username, password, beta?}     -> {ok, session, userID}   (403 NOT_YET pre-launch, see FB_BETA)
  GET  /evals                                  -> {ok, evals:[{requestid, eimnum, name, updateableid,
                                                   type, subject, requested, activity, site, period, timeframe}]}
  GET  /form?requestid&eimnum&name&updateableid -> {ok, info:{...}, items:[{name, kind, title, prompt,
                                                   mandatory, confidential, options?, value}]}
  POST /close  {requestid, eimnum, name, updateableid, answers:{field: value}, final:bool}
               final=false -> e-value "Save For Later" (still editable)
               final=true  -> e-value "Submit" (locks it; e-value may email people)
                                               -> {ok, message} | {ok:false, reason}
  POST /notify {email}                         -> {ok:true}   (launch mailing list, no session needed)
  GET  /ping                                   -> {ok:true}

Egress: e-value's Cloudflare bans datacenter ASNs, so set
EV_SOCKS_PROXY=socks5h://<home-pc-nebula-ip>:1080 to exit through a residential line.
"""

import json
import os
import re
import secrets
import threading
import time
from html import unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse

import requests

EV = 'https://www.e-value.net'
PORT = int(os.environ.get('FB_PORT', '8104'))
DATA_DIR = os.environ.get('FB_DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
SESSION_TTL = 8 * 60 * 60  # seconds
BETA_CODE = os.environ.get('FB_BETA', '')  # set = pre-launch: /login needs this code
ALLOWED_ORIGINS = tuple(o.strip() for o in os.environ.get(
    'FB_ORIGINS', 'https://eh.robbiemed.org,https://robbie-med.github.io,http://localhost,http://127.0.0.1').split(',') if o.strip())

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) '
      'Gecko/20100101 Firefox/147.0')

# Login only "takes" after the browser's post-login navigation chain.
NAV_CHAIN = [
    '/index.cfm?fuseaction=main_loginscreen&aiInstitutionCode=',
    '/dsp_variables.cfm',
    '/index.cfm?fuseaction=users_login&institutioncode=',
    '/index.cfm?fuseaction=users_sethomepage',
    '/includes/top_menu.cfm',
    '/userAuthRedirect.cfm',
]

LIST_PAGE = EV + '/index.cfm?fuseaction=users_evalmodules&menu=19&accessid=2'
# recordAnswer() question types we know how to send. Anything else (true/false, yes/no,
# multi-select, time, numeric…) is "unsupported": the app sends it to e-value to finish.
CHOICE_TYPES = {'1', '4', '11', '12', '15', '24'}

os.makedirs(DATA_DIR, exist_ok=True)
_file_lock = threading.Lock()


def text_of(html):
    html = re.sub(r'<(style|script)\b[\s\S]*?</\1>', ' ', html or '', flags=re.I)
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', ' ', html))).strip()


def attr(tag, name):
    m = re.search(r'\b' + name + r'\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))', tag, re.I)
    return unescape(next(g for g in m.groups()[1:] if g is not None)) if m else None


def js_args(call):
    """"recordAnswer(11,'answer_1_2',0,2,36,9,1)" -> ['11', 'answer_1_2', '0', '2', '36', '9', '1']"""
    m = re.search(r'record(?:Answer|Essay)\(([^)]*)\)', call or '')
    return [a.strip().strip("'") for a in m.group(1).split(',')] if m else []


def looks_logged_out(html):
    # The genuine login screen has the credential form; the post-login
    # frameset references "main_loginscreen" too, so don't key on that.
    return 'AIpassword' in html or 'name="AIusername"' in html


# ---------------------------------------------------------------- page parsers

def parse_list(html):
    """The pending-evaluations page: one grey header table per activity, then a row per evaluation."""
    out = []
    for block in re.split(r'<table class="small" bgcolor="EEEEEE"', html)[1:]:
        head = dict(re.findall(r'<strong>\s*([\w ]+):\s*</strong>\s*</td>\s*<td[^>]*>([\s\S]*?)</td>', block))
        head = {k.strip(): text_of(v) for k, v in head.items()}
        for row in re.findall(r'<tr class="hover">([\s\S]*?)</tr>', block):
            link = re.search(r'href="(index\.cfm\?fuseaction=users_getevaleimnum&[^"]+)"', row)
            if not link:
                continue
            q = parse_qs(urlparse(unescape(link.group(1))).query)
            cells = [text_of(c) for c in re.findall(r'<td[^>]*>([\s\S]*?)</td>', row)]
            out.append({
                **{k: q.get(k, [''])[0] for k in ('requestid', 'eimnum', 'name', 'updateableid')},
                'type': cells[2] if len(cells) > 2 else '', 'subject': cells[3] if len(cells) > 3 else '',
                'requested': cells[4] if len(cells) > 4 else '',
                'activity': head.get('Activity', ''), 'site': head.get('Site', ''),
                'period': head.get('Period', ''), 'timeframe': head.get('Time Frame', ''),
            })
    return out


def parse_form(html):
    """dsp_evaltest.cfm -> (info, items, hidden, meta).
    items: one per answer field, in page order, with what the app needs to show/fill it.
    hidden: the answerform's hidden inputs (posted back as-is). meta: autosave ids."""
    form = re.search(r'<form[^>]*name="answerform"[\s\S]*?</form>', html, re.I)
    form = form.group(0) if form else ''
    info = {k: text_of(v) for k, v in re.findall(
        r'<TD[^>]*><B>([^<:]+):?\s*</B></TD>\s*<TD[^>]*>([\s\S]*?)</TD>', form)}
    hidden = [(attr(t, 'name'), attr(t, 'value') or '') for t in re.findall(r'<input[^>]*type="hidden"[^>]*>', form, re.I)]
    essay = re.search(r'<FORM[^>]*Name="HiddenEssay"[\s\S]*?</FORM>', html, re.I)
    meta = {attr(t, 'name'): attr(t, 'value') for t in re.findall(r'<Input[^>]*>', essay.group(0) if essay else '', re.I)}

    items = []
    for chunk in re.split(r'<a name="Question_\d+"', form)[1:]:
        hdr = re.search(r'\(Question&nbsp;\d+&nbsp;of&nbsp;\d+([^)]*)\)', chunk)
        if not hdr:
            continue
        before = chunk[:hdr.start()]
        bold = max(before.lower().rfind('<b>'), before.lower().rfind('<strong>'))
        title = text_of(before[bold:]) if bold >= 0 else ''
        ctrl = re.search(r'<(input(?![^>]*type="hidden")|select|textarea)\b', chunk[hdr.end():], re.I)
        prompt = text_of(chunk[hdr.end():hdr.end() + (ctrl.start() if ctrl else 0)])[:800]
        base = {'title': title, 'prompt': prompt, 'mandatory': 'Mandatory' in hdr.group(1),
                'confidential': 'Confidential' in hdr.group(1)}
        labels = {attr(m.group(0), 'for'): text_of(m.group(1))
                  for m in re.finditer(r'<label[^>]*>([\s\S]*?)</label>', chunk, re.I)}
        fields = {}  # name -> item, in page order

        for tag in re.findall(r'<input\b[^>]*>', chunk, re.I | re.S):
            name, typ = attr(tag, 'name') or '', (attr(tag, 'type') or 'text').lower()
            if not name.startswith('answer_') or typ == 'hidden':
                continue
            args = js_args(attr(tag, 'onclick') or attr(tag, 'onchange'))
            qtype = args[0] if args else ''
            if typ == 'radio':
                it = fields.setdefault(name, {**base, 'name': name, 'kind': 'choice', 'options': [], 'value': '',
                                              'qtype': qtype, 'low': args[4:5], 'scale': args[5:6]})
                v = attr(tag, 'value') or ''
                aria = re.sub(r'\s*value \d+$', '', attr(tag, 'aria-label') or '')
                it['options'].append({'v': v, 'l': labels.get(attr(tag, 'id')) or aria or v,
                                      'ta': args[2] if len(args) > 2 else v})
                if re.search(r'\bchecked\b', tag, re.I):
                    it['value'] = v
                if qtype not in CHOICE_TYPES:
                    it['kind'] = 'unsupported'
            elif typ == 'text':
                fields[name] = {**base, 'name': name, 'value': attr(tag, 'value') or '', 'qtype': qtype,
                                'kind': 'date' if qtype == '16' else 'unsupported'}
            else:
                fields[name] = {**base, 'name': name, 'kind': 'unsupported', 'value': ''}

        for m in re.finditer(r'(<select\b[^>]*>)([\s\S]*?)</select>', chunk, re.I):
            name = attr(m.group(1), 'name') or ''
            args = js_args(attr(m.group(1), 'onchange'))
            opts = [{'v': v, 'l': text_of(l)} for v, l in
                    re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', m.group(2), re.I) if v != '99']
            sel = re.search(r'<option[^>]*value="([^"]*)"[^>]*\bselected\b', m.group(2), re.I)
            fields[name] = {**base, 'name': name, 'kind': 'choice' if args and args[0] in CHOICE_TYPES else 'unsupported',
                            'options': opts, 'value': sel.group(1) if sel and sel.group(1) != '99' else '',
                            'qtype': args[0] if args else '', 'ta': args[2] if len(args) > 2 else '0',
                            'low': args[4:5], 'scale': args[5:6]}

        for m in re.finditer(r'(<textarea\b[^>]*>)([\s\S]*?)</textarea>', chunk, re.I):
            name = attr(m.group(1), 'name') or ''
            fields[name] = {**base, 'name': name, 'kind': 'text', 'value': unescape(m.group(2)).strip()}

        items += [f for n, f in fields.items() if n.startswith('answer_')]
    return info, items, hidden, meta


def store_query(ids, it, v):
    """hid_storeanswer.cfm query, as recordAnswer() builds it when an answer is clicked."""
    ta = it['ta'] if 'ta' in it else next((o['ta'] for o in it.get('options', []) if o['v'] == v), v)
    return urlencode({**ids, 'questionname': it['name'], 'qtype': it['qtype'], 'theanswer': ta, 'answer': v,
                      'essay': '', 'lowscore': (it.get('low') or ['undefined'])[0],
                      'thescale': (it.get('scale') or ['undefined'])[0], 'popuprule': '1', 'calcdest': '0'},
                     quote_via=quote)


def close_form(hidden, items, answers, final):
    """The users_closemodule POST, field for field as the page sends it."""
    data = [(k, v) for k, v in hidden if not k.endswith('_date') and k != 'HidSFL'] + [('scrolloption', '0')]
    dates = dict((k, v) for k, v in hidden if k.endswith('_date'))
    for it in items:
        data.append((it['name'], answers.get(it['name'], '')))
        if it['name'] + '_date' in dates:
            data.append((it['name'] + '_date', dates[it['name'] + '_date']))
    data += ([('Action', 'Save For Later'), ('HidSFL', 'Save For Later')] if not final
             else [('HidSFL', ''), ('Action', 'Submit')])
    return data


# ---------------------------------------------------------------- JSON file store

def _sess_path(token):
    return os.path.join(DATA_DIR, f'sess_{token}.json') if re.fullmatch(r'[a-f0-9]{64}', token or '') else None


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path, data):
    with _file_lock:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)


def load_session(token):
    path = _sess_path(token)
    sess = read_json(path) if path else None
    if sess and time.time() - sess.get('createdAt', 0) > SESSION_TTL:
        os.remove(path)
        return None
    return sess


# ---------------------------------------------------------------- e-value client

class SessionExpired(Exception):
    pass


class EgressBlocked(Exception):
    pass


class EvClient:
    """One e-value session: cookie jar + the evaluation request flow."""

    def __init__(self):
        self.http = requests.Session()
        self.http.headers.update({'User-Agent': UA})
        proxy = os.environ.get('EV_SOCKS_PROXY')
        if proxy:
            self.http.proxies = {'http': proxy, 'https': proxy}
        self.user_id = None
        self.subunit_id = None

    def _request(self, method, url, data=None, retries=3, redirects=True):
        last = None
        for attempt in range(retries):
            try:
                resp = self.http.request(method, url, data=data, timeout=60, allow_redirects=redirects)
                if resp.status_code == 403 and 'error code: 1005' in resp.text:
                    raise EgressBlocked('e-value.net has ASN-banned this egress IP '
                                        '(Cloudflare error 1005) — check the home-exit proxy')
                # The origin intermittently 520s; retrying is the fix.
                if resp.status_code != 520:
                    return resp
                last = resp
            except requests.RequestException as exc:
                last = exc
            time.sleep(1.5 * (attempt + 1))
        if isinstance(last, Exception):
            raise last
        return last

    def page(self, url):
        html = self._request('GET', url).text
        if looks_logged_out(html):
            raise SessionExpired()
        return html

    def set_js_cookies(self):
        """The browser sets these via JS after login; the server reads some of them."""
        jar = {c.name: c.value for c in self.http.cookies}
        for name, value in [
            ('EVALUECFID', jar.get('CFID', '')), ('EVALUECFTOKEN', jar.get('CFTOKEN', '')),
            ('EVALUEUSERID', self.user_id or ''), ('EVUSERID', self.user_id or ''),
            ('EVSUBUNITID', self.subunit_id or ''), ('EVSUPERUSER', '0'),
            ('CFSUID', f'{self.subunit_id}|na'), ('laccess', '0'), ('lmenu', '0'),
            ('ENVIRONMENT', 'EVALUEPRODUCTION'), ('TIMEOUT', '20'), ('MODALTIMEOUT', '180000'),
        ]:
            self.http.cookies.set(name, value, domain='www.e-value.net', path='/')

    def login(self, username, password):
        self._request('GET', EV + '/index.cfm')
        resp = self._request('POST', EV + '/index.cfm', {
            'isLoggingIn': 'yes', 'ppc': '0', 'AIusername': username,
            'AIpassword': password, 'AIInstitutionCode': '',
        })
        if looks_logged_out(resp.text):
            return False
        for path in NAV_CHAIN:
            self._request('GET', EV + path)
        ids = re.search(r"User_ID: ' \+ (\d+) \+ ', Subunit_ID: ' \+ (\d+)", self.page(LIST_PAGE))
        if ids:
            self.user_id, self.subunit_id = ids.groups()
        self.set_js_cookies()
        return bool(self.user_id)

    def evals(self):
        return parse_list(self.page(LIST_PAGE))

    def form(self, ev):
        """Open an evaluation like the list page's link does (frameset, then its form frame)."""
        q = {'fuseaction': 'users_getevaleimnum', 'requestid': ev['requestid'], 'eimnum': ev['eimnum'],
             'name': ev['name'], 'accessid': '2', 'updateableid': ev['updateableid']}
        self.page(EV + '/index.cfm?' + urlencode(q, quote_via=quote))
        return parse_form(self.page(f"{EV}/users/dsp_evaltest.cfm?view=0&accessid=2&eimnum={ev['eimnum']}"
                                    f"&diffList=&requestid={ev['requestid']}&path="))

    def close(self, ev, answers, final):
        """Autosave every answer the way the page does as you click, then Save For Later / Submit.
        Returns (ok, message)."""
        info, items, hidden, meta = self.form(ev)
        if not items:
            return False, 'could not read this evaluation form'
        problems = [f"unanswered: {it['title'] or it['name']}" for it in items
                    if final and it['mandatory'] and not str(answers.get(it['name'], '')).strip()]
        problems += [f"bad answer: {it['title'] or it['name']}" for it in items
                     if (it['kind'] == 'unsupported' and answers.get(it['name']))
                     or (it['kind'] == 'choice' and answers.get(it['name'])
                         and answers[it['name']] not in {o['v'] for o in it['options']})]
        if problems:
            return False, 'not sent: ' + '; '.join(problems)
        ids = {'activityid': meta.get('activityid', ''), 'moduleid': meta.get('moduleid', ''), 'eimnum': ev['eimnum']}
        for it in items:
            v = str(answers.get(it['name'], ''))
            if it['kind'] == 'text':
                self._request('POST', EV + '/users/hid_storeessay.cfm', {'essay': v, 'questionname': it['name'], **ids})
            elif it['kind'] in ('choice', 'date') and v:
                r = self._request('GET', EV + '/users/hid_storeanswer.cfm?' + store_query(ids, it, v))
                if 'low score threshold' in r.text:
                    return False, (f'"{it["title"]}" is below the program\'s low-score threshold, so e-value '
                                   'wants comments explaining it. Answers were saved as a draft; finish it on e-value.')
        resp = self._request('POST', EV + '/index.cfm', close_form(hidden, items, answers, final), redirects=False)
        loc = unquote(resp.headers.get('Location', ''))
        msg = re.search(r'message=([^&]*)', loc)
        msg = msg.group(1).replace('\\n', ' ').strip() if msg else ''
        if 'Thank you for completing' in msg or (not final and 'have been saved' in msg):
            return True, msg
        return False, msg or f'unexpected e-value reply (HTTP {resp.status_code})'

    def dump_cookies(self):
        return [{'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path}
                for c in self.http.cookies]

    def load_cookies(self, cookies):
        for c in cookies:
            self.http.cookies.set(c['name'], c['value'], domain=c['domain'], path=c['path'])


# ---------------------------------------------------------------- HTTP API

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'meh-value-proxy'

    def log_message(self, fmt, *args):  # keep logs free of URLs that may carry tokens
        pass

    def _cors_origin(self):
        origin = self.headers.get('Origin', '')
        for allowed in ALLOWED_ORIGINS:
            if origin == allowed or origin.startswith(allowed + ':'):
                return origin
        return None

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _client(self):
        """Rebuild an EvClient from the session token; raises SessionExpired."""
        sess = load_session(self.headers.get('X-Session', ''))
        if not sess:
            raise SessionExpired()
        client = EvClient()
        client.load_cookies(sess['cookies'])
        client.user_id, client.subunit_id = sess.get('userID'), sess.get('subunitID')
        client.set_js_cookies()
        return client, sess

    def _persist(self, client, sess, token=None):
        sess.update({'cookies': client.dump_cookies(), 'userID': client.user_id, 'subunitID': client.subunit_id})
        write_json(_sess_path(token or self.headers.get('X-Session', '')), sess)

    def _ev(self, src):
        """The four ids that open one evaluation, validated; None if any is malformed."""
        ev = {k: str(src.get(k, '')) for k in ('requestid', 'eimnum', 'name', 'updateableid')}
        ok = (re.fullmatch(r'\d+', ev['requestid']) and re.fullmatch(r'\d+', ev['eimnum'])
              and re.fullmatch(r'[a-f0-9]{16,128}', ev['updateableid']) and 0 < len(ev['name']) < 200)
        if not ok:
            self._send_json({'ok': False, 'reason': 'bad evaluation ids'}, 400)
        return ev if ok else None

    # -- routing --

    def do_OPTIONS(self):
        origin = self._cors_origin()
        self.send_response(204)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Session')
            self.send_header('Access-Control-Max-Age', '86400')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _route(self, routes):
        try:
            handler = routes.get(urlparse(self.path).path)
            if handler:
                handler()
            else:
                self._send_json({'ok': False, 'reason': 'not found'}, 404)
        except SessionExpired:
            self._send_json({'ok': False, 'reason': 'SESSION_EXPIRED'}, 401)
        except EgressBlocked as exc:
            self._send_json({'ok': False, 'reason': f'EGRESS_BLOCKED: {exc}'}, 502)
        except requests.RequestException as exc:
            self._send_json({'ok': False, 'reason': f'e-value unreachable: {exc}'}, 502)
        except Exception as exc:
            self._send_json({'ok': False, 'reason': f'proxy error: {exc}'}, 500)

    def do_GET(self):
        self._route({'/ping': lambda: self._send_json({'ok': True, 'service': 'meh-value-proxy'}),
                     '/evals': self._evals, '/form': self._form})

    def do_POST(self):
        self._route({'/login': self._login, '/close': self._close, '/notify': self._notify})

    # -- handlers --

    def _login(self):
        body = self._body()
        if BETA_CODE and not secrets.compare_digest(str(body.get('beta', '')), BETA_CODE):
            self._send_json({'ok': False, 'reason': 'NOT_YET'}, 403)
            return
        if not body.get('username') or not body.get('password'):
            self._send_json({'ok': False, 'reason': 'missing credentials'}, 400)
            return
        client = EvClient()
        if not client.login(body['username'], body['password']):
            self._send_json({'ok': False, 'reason': 'INVALID_CREDENTIALS'}, 401)
            return
        token = secrets.token_hex(32)
        self._persist(client, {'createdAt': time.time()}, token)
        self._send_json({'ok': True, 'session': token, 'userID': client.user_id})

    def _notify(self):
        """Launch mailing list: one JSON line per new address in data/notify.jsonl."""
        email = str(self._body().get('email', '')).strip().lower()
        if len(email) > 254 or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[a-z]{2,}', email):
            self._send_json({'ok': False, 'reason': 'That doesn’t look like an email.'}, 400)
            return
        path = os.path.join(DATA_DIR, 'notify.jsonl')
        with _file_lock:
            try:
                with open(path, encoding='utf-8') as f:
                    known = f.read()
            except OSError:
                known = ''
            if len(known) > 1_000_000:  # ponytail: hard cap instead of rate limiting
                self._send_json({'ok': False, 'reason': 'List is full.'}, 503)
                return
            if f'"{email}"' not in known:
                with open(path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps({'email': email, 'at': time.strftime('%Y-%m-%d %H:%M:%S')}) + '\n')
        self._send_json({'ok': True})

    def _evals(self):
        client, sess = self._client()
        evals = client.evals()
        self._persist(client, sess)
        self._send_json({'ok': True, 'evals': evals})

    def _form(self):
        ev = self._ev({k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()})
        if not ev:
            return
        client, sess = self._client()
        info, items, _, _ = client.form(ev)
        self._persist(client, sess)
        keep = ('name', 'kind', 'title', 'prompt', 'mandatory', 'confidential', 'value')
        self._send_json({'ok': True, 'info': info, 'items': [
            {**{k: it[k] for k in keep},
             **({'options': [{'v': o['v'], 'l': o['l']} for o in it['options']]} if 'options' in it else {})}
            for it in items]})

    def _close(self):
        body = self._body()
        ev = self._ev(body)
        if not ev:
            return
        answers = body.get('answers')
        if not isinstance(answers, dict) or not isinstance(body.get('final'), bool):
            self._send_json({'ok': False, 'reason': 'need answers{} and final true/false'}, 400)
            return
        client, sess = self._client()
        ok, msg = client.close(ev, {str(k): str(v) for k, v in answers.items()}, body['final'])
        self._persist(client, sess)
        self._send_json({'ok': ok, 'message' if ok else 'reason': msg}, 200 if ok else 409)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'meh-value-proxy listening on 127.0.0.1:{PORT}')
    server.serve_forever()

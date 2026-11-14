/* app.js — eh.: pick a vibe, get a filled-in e-value evaluation, review, send.
 *
 * Ratings stay positive and inside the "no comment required" band: never under the program's
 * low-score threshold, never the top box of a long scale. Comments are generic boilerplate in the
 * terse annual-rating style, built from a tiny grammar ({a|b} picks one) so no two read the same.
 * Non-rating questions (% time on rotation, competency…) reuse whatever you picked last time.
 * Nothing goes to e-value until you press Submit twice (or Save draft, which stays editable).
 */
'use strict';

const DEFAULT_PROXY = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://localhost:8104' : 'https://eh-api.robbiemed.org';
const VIBES = [
  { id: 'loved', emoji: '🤩', label: 'Loved it', band: [0.86, 0.9] },
  { id: 'good', emoji: '🙂', label: 'Good', band: [0.72, 0.86] },
  { id: 'fine', emoji: '😐', label: 'Fine', band: [0.55, 0.66] },
  { id: 'ghost', emoji: '🤷', label: 'Never met', band: null, facultyOnly: true }, // everything N/A
];
const KIND = { fac: 'Faculty', rot: 'Rotation', proc: 'Procedure' };

const $ = id => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const store = {
  get(k, fb) { try { const v = localStorage.getItem('eh.' + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) { try { localStorage.setItem('eh.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('eh.' + k); } catch { /* */ } },
};

let settings = store.get('settings', { proxy: DEFAULT_PROXY, username: '', password: '' });
let session = store.get('session', null);
let memo = store.get('memo', {});   // question id -> value, for non-rating questions
let evals = store.get('evals', []);
const forms = {};                   // eimnum -> {info, items} (prefetched)
let open = null;                    // {ev, form, vibe, answers, mood}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- proxy API ----------
async function api(path, { method = 'GET', body, params } = {}, retried = false) {
  let url = (settings.proxy || DEFAULT_PROXY).replace(/\/+$/, '') + path;
  if (params) url += '?' + new URLSearchParams(params);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session && path !== '/login') headers['X-Session'] = session.token;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Can’t reach the eh. proxy — check your connection.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && data && data.reason === 'SESSION_EXPIRED' && !retried) {
    await login(); // silent re-login with the stored credentials, once
    return api(path, { method, body, params }, true);
  }
  if (data && data.ok) return data;
  throw new Error((data && data.reason) || `HTTP ${res.status}`);
}

async function login() {
  if (!settings.username || !settings.password) throw new Error('Log in first.');
  const d = await api('/login', { method: 'POST', body: { username: settings.username, password: settings.password, beta: store.get('beta', '') } }, true);
  session = { token: d.session, userID: d.userID };
  store.set('session', session);
}

const evIds = ev => ({ requestid: ev.requestid, eimnum: ev.eimnum, name: ev.name, updateableid: ev.updateableid });

// ---------- boilerplate grammar ----------
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

/** "{Superb|Strong} {clinician|teacher}; $last…" -> one random reading, tidied up. */
function say(tpl, vars) {
  let s = Array.isArray(tpl) ? pick(tpl) : tpl;
  for (let guard = 0; /\{[^{}]*\}/.test(s) && guard < 200; guard++) s = s.replace(/\{([^{}]*)\}/, (_, alts) => pick(alts.split('|')));
  s = s.replace(/\$(\w+)/g, (_, k) => vars[k] ?? '');
  return s.split('\n').map(line => line.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/\s*—\s*/g, '—').trim()
    .replace(/^./, c => c.toUpperCase()).replace(/([.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase())).join('\n');
}

// Faculty: one-liners in annual-rating voice. $who = "Dr. Ellen".
const FAC = {
  praise: {
    loved: [
      '{Superb|Exceptional|Outstanding} {clinician-educator|teaching attending|preceptor}; {consistently|routinely} {made time to teach|turned every patient into a teaching moment} {despite|even with} {a heavy clinic load|high patient volume|a packed schedule}—{the standard for faculty|a model for residents|my top preceptor this year}.',
      '{Top-tier|Elite|Absolutely superior} {teacher|preceptor}; {sharp clinical judgment|deep fund of knowledge} {paired with|matched by} {genuine investment in|real care for} resident {growth|learning}—{would work with $who again in a heartbeat|seek out this rotation for this preceptor}.',
    ],
    good: [
      '{Strong|Solid|Highly effective} {preceptor|teaching attending}; {clear|practical|efficient} teaching {grounded in|rooted in} {real-world|everyday} {primary care|outpatient} {practice|medicine}—{residents leave better prepared|a valuable part of the rotation}.',
      '{Knowledgeable|Approachable|Dependable}, {resident-focused|patient-centered} {attending|preceptor}; {created|fostered} a {supportive|positive|safe} learning environment—{teaching was consistently high-yield|always willing to answer questions}.',
    ],
    fine: [
      '{Dependable|Reliable|Steady} {preceptor|attending}; {provided|offered} {sound|safe} {clinical guidance|supervision} and {was approachable|answered questions readily}—{met expectations for the rotation|a solid supervising physician}.',
    ],
  },
  improve: {
    loved: [
      '{None noted|Nothing significant|No areas of concern}{—|; }{continue current approach|sustain current teaching style|keep doing exactly this}.',
      '{None noted|Nothing to add}{—|; }{already|consistently} {operating at the highest level|exceeding expectations} in this area.',
    ],
    good: [
      '{Continue to|Encourage $who to} $tip{—|; }{already strong|already effective} in this area.',
      '{Minor|Only minor} {point|suggestion}: {continue to|encourage $who to} $tip.',
    ],
    fine: [
      '{Continue to|Could} $tip to {further|} {strengthen|build on} {an already solid|a solid} {teaching|learning} {experience|environment}.',
      '{Opportunity|Room} to $tip; {otherwise|overall} {met expectations|a solid experience}.',
    ],
    ghost: [
      '{Did not work with|No direct contact with} $who {this rotation|during this block}{—|; }{unable to evaluate|cannot evaluate|N/A}.',
      'N/A{—|; }{did not work with|no clinical contact with} $who {this rotation|during this block}.',
    ],
  },
  tips: {
    knowledge: ['{share|walk through} the {evidence|guidelines|literature} behind {decisions|management choices} {in real time|as cases come up}',
      'point residents to {a key article|a go-to reference|the relevant guideline} after {interesting|complex} cases'],
    teaching: ['{build in|add} {a quick|a brief} {teaching point|teaching pearl} {at the end of clinic|between patients}',
      '{set|review} {learning goals|rotation goals} {at the start of the rotation|in the first week}',
      'give residents {more|increasing} {autonomy|ownership} {in|over} {the plan|management decisions}'],
    attitude: ['{check in|do a brief check-in} {midway through|halfway through} the rotation',
      'involve residents {more|earlier} in {shared decision making|planning}'],
    feedback: ['provide {brief|more frequent|real-time} {feedback|formative feedback} {during|throughout} the rotation',
      'hold {a short|a quick} mid-rotation feedback {session|check-in}'],
    other: ['{provide|offer} {brief|regular} {feedback|check-ins} {during|throughout} the rotation',
      'set {clear|explicit} {expectations|goals} {on day one|at the start of the rotation}'],
  },
};

// Rotation: Strengths / Weaknesses / Suggestions lines. $rot = "OPHTH".
const ROT = {
  strengths: {
    loved: ['{High-yield|Outstanding|Exceptional} rotation; {broad|rich|excellent} exposure to {core|high-yield|bread-and-butter} $rot {presentations|pathology|cases}—{directly applicable to|immediately relevant to} {family medicine|primary care} {practice|}. {Preceptors|Faculty} {fully invested in|genuinely committed to} {teaching|resident education}.'],
    good: ['{Solid|Strong|Well-run} rotation; {good|consistent} exposure to {common|core} $rot {presentations|complaints|cases} {relevant to|seen in} {family medicine|primary care}. {Preceptors|Faculty} {approachable|welcoming} and {willing to teach|teaching-focused}.'],
    fine: ['{Reasonable|Adequate|Useful} exposure to {common|core} $rot {presentations|cases} {relevant to|applicable to} {primary care|outpatient practice}; {staff|preceptors} {welcoming|helpful|supportive}.'],
  },
  weaknesses: {
    loved: ['{Minimal|None significant|Very few}; {rotation|block} {felt short|went by quickly}—{would welcome more time|more weeks would only help}.'],
    good: ['{Minor|Few}; {hands-on|independent} {time|opportunities} {limited at times|varied} {by|with} {clinic pace|patient volume}.'],
    fine: ['{Resident role|Expectations} {not always clearly defined|could be clearer}; {hands-on|independent} {time|involvement} {limited|variable} {at times|on busier days}.'],
  },
  suggestions: {
    loved: ['{Sustain|Maintain|Keep} {current structure|current format}; {consider adding|could add} {a short|a brief} {high-yield reading list|orientation} to {maximize|boost} {day-one readiness|learning from the start}.'],
    good: ['{Add|Consider} {a brief|a short} {orientation|goals list} {on day one|at the start} to {maximize|get the most out of} {the rotation|hands-on time}.'],
    fine: ['{Define|Clarify} {resident expectations|learning objectives} {on day one|up front}; {add|build in} {more|structured} {hands-on|teaching} {time|opportunities} {where possible|when volume allows}.'],
  },
};
const ROT_SWOT = v => `Strengths: ${ROT.strengths[v][0]}\nWeaknesses: ${ROT.weaknesses[v][0]}\nSuggestions: ${ROT.suggestions[v][0]}`;

// Procedures (you are rating your own precepted procedure). $proc = "POCUS-OB/GYN".
const PROC = {
  positive: ['{Completed|Performed} $proc {under direct supervision|with preceptor oversight}; {sound|appropriate} {preparation|setup|patient positioning} and {clear|effective} {communication with the patient|patient explanation}. {Obtained|Achieved} {adequate|standard|diagnostic} {views|results} {with guidance|with minimal prompting}.'],
  improve: ['{Continue to|Will continue to} {build|develop} {speed|efficiency|consistency} {with|in} {the technical steps|technique} {through|via} {additional|more} {supervised|} {repetitions|reps|cases} {before performing independently|toward independence}.'],
};

function vibeKey(v) { return v === 'ghost' ? 'fine' : v; }

/** A text answer for one question, or '' to leave blank (confidential boxes are always left blank). */
function writeComment(it, kind, vibe, vars) {
  const t = `${it.title} ${it.prompt}`.toLowerCase();
  if (it.confidential || /confidential|pearl/.test(t)) return '';
  const v = vibeKey(vibe);
  if (kind === 'proc') return say(/improv/.test(it.title.toLowerCase()) ? PROC.improve : PROC.positive, vars);
  if (kind === 'rot') {
    if (/strength|weakness/.test(t)) return say(ROT_SWOT(v), vars);
    if (/schedule|suggest|change|improv/.test(t)) return say(ROT.suggestions[v], vars);
    return say(ROT.strengths[v], vars);
  }
  if (vibe === 'ghost') return say(FAC.improve.ghost, vars);
  if (/improv|weakness|change|better/.test(t)) {
    const topic = /knowledge/.test(t) ? 'knowledge' : /feedback/.test(t) ? 'feedback'
      : /attitude|enthusias|role model/.test(t) ? 'attitude' : /teach|skill|didactic/.test(t) ? 'teaching' : 'other';
    const tip = say(FAC.tips[topic], vars).replace(/^./, c => c.toLowerCase());
    return say(FAC.improve[vibe] || FAC.improve[v], { ...vars, tip });
  }
  return say(FAC.praise[v], vars);
}

// ---------- ratings ----------
const NA_RE = /^(0|n\/?a)$|not applicable|not observed|cannot evaluate|insufficient|unable/i;
const RATING_RE = /^\d+\b|poor|fair|good|excellent|outstanding|satisf|marginal|meets|superior|exceed/i;
const qid = name => name.split('_')[2];

/** Ordered rating options (N/A removed) if this choice question is a rating scale, else null. */
function ratingScale(it) {
  const opts = (it.options || []).filter(o => /^\d+$/.test(o.v));
  if (opts.length < 3 || opts.length !== it.options.length || !opts.every(o => RATING_RE.test(o.l) && !/%/.test(o.l))) return null;
  const real = opts.filter(o => !(o.v === '0' && NA_RE.test(o.l)));
  return real.sort((a, b) => a.v - b.v);
}
const naOption = it => (it.options || []).find(o => o.v === '0' && NA_RE.test(o.l));

/** Positive, comment-free rating: inside the vibe's band, never the top box of a 7+ point scale. */
function rate(scale, vibe, mood) {
  const band = (VIBES.find(v => v.id === vibe) || VIBES[1]).band || VIBES[2].band;
  const f = Math.min(band[1], Math.max(band[0], mood + rand(-0.05, 0.05)));
  const top = scale.length >= 7 ? scale.length - 2 : scale.length - 1;
  const floor = Math.ceil((scale.length - 1) * 0.5); // middle of the scale = "meets expectations"
  return scale[Math.min(top, Math.max(floor, Math.round(f * (scale.length - 1))))].v;
}

/** Non-rating choices: "% of time on rotation" is always the top %, then last time's answer,
 *  then the unremarkable answer ("Just right", "Further supervision required"). */
function defaultChoice(it) {
  if (it.options.every(o => /^\s*\d+\s*%/.test(o.l))) return it.options.reduce((a, b) => (parseFloat(b.l) > parseFloat(a.l) ? b : a)).v;
  const m = memo[qid(it.name)];
  if (m && it.options.some(o => o.v === m)) return m;
  const easy = it.options.find(o => /just right|about right|appropriate|adequate|further supervision/i.test(o.l));
  return easy ? easy.v : '';
}

function evKind(ev) { return /rotation/i.test(ev.type) ? 'rot' : /procedure/i.test(ev.type) ? 'proc' : 'fac'; }

function varsFor(ev, form) {
  const subj = (form.info.Subject || ev.subject).split(',')[0].trim();
  const last = subj.split(/\s+/).pop();
  return {
    who: evKind(ev) === 'fac' ? `Dr. ${last}` : subj, last, rot: ev.activity || subj,
    proc: form.info.Procedure || (ev.type.match(/Procedure\s+(.+)$/i) || [, 'the procedure'])[1],
  };
}

/** Fresh answers for a vibe. Keeps your manual edits only when asked (vibe switch keeps none). */
function generate(ev, form, vibe) {
  const kind = evKind(ev), vars = varsFor(ev, form);
  const band = (VIBES.find(v => v.id === vibe) || VIBES[1]).band || VIBES[2].band;
  const mood = rand(band[0], band[1]); // one mood per evaluation so ratings hang together
  const answers = {};
  for (const it of form.items) {
    if (it.kind === 'choice') {
      const scale = ratingScale(it);
      const na = naOption(it);
      answers[it.name] = scale ? (vibe === 'ghost' && na ? na.v : rate(scale, vibe, mood)) : (it.value || defaultChoice(it));
    } else if (it.kind === 'text') {
      answers[it.name] = writeComment(it, kind, vibe, vars) || it.value;
    } else if (it.kind === 'date') {
      answers[it.name] = it.mandatory ? new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : it.value;
    } else {
      answers[it.name] = '';
    }
  }
  return answers;
}

const needsYou = (form, answers) => form.items.filter(it => it.mandatory && !String(answers[it.name] || '').trim());

// ---------- inbox ----------
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === 'screen-' + screen);
  $('tabs').classList.toggle('hidden', screen !== 'inbox');
}

let tab = store.get('tab', 'todo');
function setTab(t) {
  tab = t;
  store.set('tab', t);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('active', p.id === 'pane-' + t);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  window.scrollTo(0, 0);
}

function vibeRow(onPick, kind, current) {
  const row = el('div', 'vibes');
  for (const v of VIBES) {
    if (v.facultyOnly && kind !== 'fac') continue;
    const b = el('button', 'vibe' + (v.id === current ? ' on' : ''));
    b.type = 'button';
    b.append(el('span', 'emo', v.emoji), el('span', 'vl', v.label));
    b.addEventListener('click', () => onPick(v.id, b));
    row.append(b);
  }
  return row;
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  const n = evals.length;
  $('headline').textContent = n ? `${n} to go` : 'Inbox zero';
  $('subline').textContent = errs.todo || (n ? 'Tap a vibe. We’ll write it, you glance, you send.' : 'Nothing pending in e-value. Go touch grass. 🌱');
  if (!n) list.append(el('div', 'empty', '🎉'));
  evals.forEach((ev, i) => {
    const kind = evKind(ev);
    const card = el('article', `card ev k-${kind}`);
    card.style.setProperty('--i', i);
    const top = el('div', 'ev-top');
    top.append(el('span', 'chip', KIND[kind]), el('span', 'muted small', ev.period || ev.requested));
    card.append(top, el('h3', 'ev-subj', kind === 'rot' ? ev.activity || ev.subject : ev.subject),
      el('p', 'muted small', [kind === 'proc' ? ev.type : kind === 'fac' ? ev.activity : '', ev.site].filter(Boolean).join(' · ')));
    card.append(vibeRow((vibe, btn) => openReview(ev, vibe, btn), kind));
    list.append(card);
  });
}

// One sync at a time, steps in order (to-do first, since that's what's due), each failing on its own.
let syncing = null;
const errs = {};
function refresh() {
  return syncing || (syncing = sync().finally(() => { syncing = null; $('refresh').classList.remove('spin'); }));
}
async function sync() {
  $('refresh').classList.add('spin');
  const step = async (pane, fn) => {
    try { await fn(); delete errs[pane]; } catch (err) { errs[pane] = err.message; }
    renderAll();
  };
  await step('todo', async () => { evals = (await api('/evals')).evals || []; store.set('evals', evals); });
  if (errs.todo && !evals.length) $('headline').textContent = 'Hmm.';
  await prefetch();
  await step('about', async () => { about = (await api('/about')).evals || []; store.set('about', about); });
  await step('done', async () => { done = (await api('/done')).evals || []; store.set('done', done); });
  await step('about', () => fetchViews('about', about.filter(r => r.completed)));
  await step('done', () => fetchViews('done', done));
}

// ponytail: one at a time, so the e-value session never sees parallel page loads
async function prefetch() {
  for (const ev of evals) {
    if (forms[ev.eimnum]) continue;
    try { forms[ev.eimnum] = await api('/form', { params: evIds(ev) }); } catch { /* fetched on tap instead */ }
  }
}

// ---------- completed evals: by me (done) and about me ----------
let done = store.get('done', []);   // Completed By Me rows
let about = store.get('about', []); // evaluations of you, open + completed
let views = store.get('views', {}); // key -> parsed read-only evaluation; completed ones never change
const doneKey = r => ['d', r.section, r.subject, r.type, r.requested, r.completed, r.activity].join('|');
const aboutKey = r => 'a' + r.id;
const keyOf = (src, r) => (src === 'done' ? doneKey(r) : aboutKey(r));

/** Batch-read every completed evaluation not cached yet: 25 per request, grouped by e-value section. */
async function fetchViews(src, rows) {
  const groups = {};
  for (const r of rows) if (r.tok && !views[keyOf(src, r)]) (groups[src === 'done' ? r.section : ''] ||= []).push(r);
  for (const [section, list] of Object.entries(groups)) {
    for (let i = 0; i < list.length; i += 25) {
      const chunk = list.slice(i, i + 25);
      const d = await api('/views', { method: 'POST', body: { src, section, toks: chunk.map(r => r.tok) } });
      chunk.forEach((r, j) => {
        const v = d.views[j];
        if (src === 'about' && v.id && v.id !== r.id) return; // order sanity check: never pin a view on the wrong row
        views[keyOf(src, r)] = { info: v.info, items: v.items.map(({ prompt, ...it }) => it) };
      });
      store.set('views', views);
      renderAll();
    }
  }
}

const toDate = s => { const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(s || ''); return m ? new Date(+m[3], m[1] - 1, +m[2]) : null; };
const daysBetween = (a, b) => Math.round((b - a) / 864e5);
const fmtDate = d => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '');
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f1 = x => (x == null ? '–' : x.toFixed(1));
const isMilestone = r => /milestone/i.test(r.type);
const anon = s => (!s || /suppressed/i.test(s) ? 'Anonymous' : s);

/** Mean of a view's real ratings (N/A = 0 skipped), put on a 9-point scale. */
function score9(v) {
  const r = (v?.items || []).filter(it => it.kind === 'rating' && it.value > 0 && it.max > 0);
  return r.length ? mean(r.map(it => (9 * it.value) / it.max)) : null;
}
const COMPETENCY = [
  ['Professionalism', /professional/i], ['Systems-based practice', /systems-based/i],
  ['Practice-based learning', /practice-based|learning and improvement/i],
  ['Communication', /communicat|interpersonal|verbal|rapport|education/i], ['Medical knowledge', /knowledge/i],
  ['Patient care', /patient care|history|exam|diagnos|treatment|procedur|follow-up|prevent|pacing/i],
];
const competency = title => (COMPETENCY.find(([, re]) => re.test(title)) || ['Overall'])[0];
// "Practice-Based Learning and Improvement Comments" is a competency, not an improvement prompt
const commentKind = t => (/areas? (to|for) improv|weak|growth|work on|suggest/i.test(t) ? 'improve' : /strength|positive/i.test(t) ? 'strength' : 'general');
const realText = s => s && s.trim().length > 2 && !/^(n\/?a|none|no|nothing)\.?$/i.test(s.trim());
const ABOUT_KIND = [[/milestone/i, 'Milestones'], [/direct observ/i, 'Direct obs'], [/attending/i, 'Attending'],
  [/nurse/i, 'Nurse'], [/self/i, 'Self'], [/resident|peer/i, 'Peer']];
const aboutKind = type => (ABOUT_KIND.find(([re]) => re.test(type)) || [, type])[1];

// small building blocks
function tile(big, label, sub, onTap) {
  const t = el(onTap ? 'button' : 'div', 'tile' + (onTap ? ' tap' : ''));
  if (onTap) { t.type = 'button'; t.addEventListener('click', onTap); }
  t.append(el('div', 'tile-big', big), el('div', 'tile-label', label));
  if (sub) t.append(el('div', 'tile-sub', sub));
  return t;
}
function sec(title, sub) {
  const s = el('section', 'sec');
  const h = el('div', 'sec-head');
  h.append(el('h2', null, title));
  if (sub) h.append(el('span', 'muted small', sub));
  s.append(h);
  return s;
}
function bar(label, value, max, note, flag) {
  const b = el('div', 'bar' + (flag ? ' flag' : ''));
  const top = el('div', 'bar-top');
  top.append(el('span', 'bar-label', label), el('span', 'bar-val', note ?? `${f1(value)} / ${max}`));
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.max(2, Math.min(100, (100 * value) / max))}%`;
  track.append(fill);
  b.append(top, track);
  return b;
}
function spark(points) { // points: numbers; inline SVG polyline, auto-ranged
  const lo = Math.min(...points) - 0.3, hi = Math.max(...points) + 0.3;
  const xy = points.map((p, i) => `${points.length > 1 ? (100 * i) / (points.length - 1) : 50},${30 - (30 * (p - lo)) / (hi - lo || 1)}`).join(' ');
  const w = el('div', 'spark');
  w.innerHTML = `<svg viewBox="0 -2 100 34" preserveAspectRatio="none" aria-hidden="true"><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  return w;
}
function row(title, sub, right, onTap, cls = '') {
  const r = el('button', 'row ' + cls);
  r.type = 'button';
  const mid = el('div', 'row-mid');
  mid.append(el('div', 'row-title', title), el('div', 'row-sub', sub));
  r.append(mid, el('div', 'row-right', right));
  r.addEventListener('click', onTap);
  return r;
}
function chips(options, current, onPick) {
  const c = el('div', 'chips');
  for (const [id, label] of options) {
    const b = el('button', 'fchip' + (id === current ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => onPick(id));
    c.append(b);
  }
  return c;
}
function loadingNote(pane, have, want) {
  if (errs[pane]) return el('p', 'warn', errs[pane]);
  if (want && have < want) return el('p', 'muted small loading', `Reading evaluations ${have}/${want}…`);
  return null;
}

// ---------- Done (completed by me) ----------
function renderDone() {
  const pane = $('pane-done');
  pane.replaceChildren();
  const rows = done.map(r => ({ r, d: toDate(r.completed), req: toDate(r.requested), v: views[doneKey(r)] }))
    .sort((a, b) => (b.d || 0) - (a.d || 0));
  pane.append(el('h1', 'headline', rows.length ? `${rows.length} done` : 'Done'));
  const first = rows.length && rows[rows.length - 1].d;
  pane.append(el('p', 'muted', rows.length ? `Evaluations you’ve submitted since ${fmtDate(first)}.` : errs.done || 'Loading your completed evaluations…'));
  const note = loadingNote('done', rows.filter(x => x.v).length, rows.length);
  if (note) pane.append(note);
  if (!rows.length) return;

  const now = new Date();
  const ay = new Date(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1, 6, 1); // academic year from Jul 1
  const turn = rows.filter(x => x.d && x.req).map(x => daysBetween(x.req, x.d));
  const given = rows.map(x => score9(x.v)).filter(x => x != null);
  const oldest = evals.map(e => toDate(e.requested)).filter(Boolean).sort((a, b) => a - b)[0];
  const tiles = el('div', 'tiles');
  tiles.append(
    tile(String(evals.length), 'waiting on you', oldest ? `oldest ${daysBetween(oldest, now)}d` : 'inbox zero', () => setTab('todo')),
    tile(String(rows.filter(x => x.d >= ay).length), 'this academic yr'),
    tile(turn.length ? `${median(turn)}d` : '–', 'median turnaround', 'request → submit'),
    tile(f1(mean(given)), 'avg you give', '/ 9'));
  pane.append(tiles);

  if (evals.length) {
    const act = el('div', 'act');
    act.append(el('div', 'act-text', `${evals.length} ${evals.length === 1 ? 'evaluation is' : 'evaluations are'} due${oldest ? `. The oldest was requested ${daysBetween(oldest, now)} days ago` : ''}.`));
    const go = el('button', 'btn primary', 'Knock them out');
    go.type = 'button';
    go.addEventListener('click', () => setTab('todo'));
    act.append(go);
    pane.append(act);
  }

  // last 12 months, submitted per month
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const counts = months.map(m => rows.filter(x => x.d && x.d.getFullYear() === m.getFullYear() && x.d.getMonth() === m.getMonth()).length);
  const top = Math.max(1, ...counts);
  const s1 = sec('Per month', 'last 12 months');
  const chart = el('div', 'months');
  months.forEach((m, i) => {
    const col = el('div', 'mcol');
    const b = el('div', 'mbar');
    b.style.height = `${(100 * counts[i]) / top}%`;
    if (counts[i]) b.dataset.n = counts[i];
    col.append(b, el('span', 'mlab', m.toLocaleDateString('en-US', { month: 'narrow' })));
    chart.append(col);
  });
  s1.append(chart);
  pane.append(s1);

  const s2 = sec('By type');
  const types = { fac: [], rot: [], proc: [] };
  for (const x of rows) types[evKind(x.r)].push(x);
  for (const [k, list] of Object.entries(types)) {
    if (!list.length) continue;
    const avg = mean(list.map(x => score9(x.v)).filter(x => x != null));
    s2.append(bar(KIND[k], list.length, rows.length, `${list.length}${avg != null ? ` · you give ${f1(avg)}/9` : ''}`));
  }
  pane.append(s2);

  const s3 = sec('History');
  let month = '';
  capped(s3, 'history', rows, 20, x => {
    const frag = document.createDocumentFragment();
    const m = x.d ? x.d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Undated';
    if (m !== month) { frag.append(el('div', 'group', m)); month = m; }
    const k = evKind(x.r), sc = score9(x.v);
    frag.append(row(k === 'rot' ? x.r.activity || x.r.subject : k === 'proc' ? x.r.type.replace(/^.*Procedure\s*/i, '') || 'Procedure' : x.r.subject,
      [KIND[k], k === 'fac' ? x.r.activity : '', fmtDate(x.d)].filter(Boolean).join(' · '),
      sc != null ? f1(sc) : '', () => openViewer('done', x.r), `k-${k}`));
    return frag;
  });
  pane.append(s3);
}

// ---------- About me (evaluations of you) ----------
let aboutFilter = 'all', commentFilter = 'improve';
function renderAbout() {
  const pane = $('pane-about');
  pane.replaceChildren();
  const now = new Date();
  const completed = about.filter(r => r.completed).map(r => ({ r, d: toDate(r.completed), v: views[aboutKey(r)] }))
    .sort((a, b) => (b.d || 0) - (a.d || 0));
  const open = about.filter(r => !r.completed);
  const unopened = completed.filter(x => x.r.tok && !x.r.viewed);
  pane.append(el('h1', 'headline', 'About you'));
  pane.append(el('p', 'muted', about.length ? `${completed.length} evaluations of you · ${open.length} still with evaluators.` : errs.about || 'Loading evaluations of you…'));
  const readable = completed.filter(x => x.r.tok);
  const note = loadingNote('about', readable.filter(x => x.v).length, readable.length);
  if (note) pane.append(note);
  if (!about.length) return;

  // scores: non-milestone evals, oldest -> newest
  const scored = completed.filter(x => x.v && !isMilestone(x.r)).map(x => ({ ...x, s: score9(x.v) })).filter(x => x.s != null).reverse();
  const cut = new Date(now - 90 * 864e5);
  const recent = mean(scored.filter(x => x.d >= cut).map(x => x.s)), before = mean(scored.filter(x => x.d < cut).map(x => x.s));
  const delta = recent != null && before != null ? recent - before : null;
  const nudgeable = open.filter(r => !/suppressed/i.test(r.evaluator) && toDate(r.requested) >= new Date(now - 60 * 864e5))
    .sort((a, b) => toDate(a.requested) - toDate(b.requested));
  const tiles = el('div', 'tiles');
  tiles.append(
    tile(f1(mean(scored.map(x => x.s))), 'avg rating', `/ 9 · ${scored.length} evals`),
    tile(f1(recent), 'last 90 days', delta == null ? '' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)} vs before`),
    tile(String(unopened.length), 'not opened', 'tap to read', () => { aboutFilter = 'new'; showAll.evals = true; renderAbout(); $('about-list')?.scrollIntoView({ behavior: 'smooth' }); }),
    tile(String(nudgeable.length), 'awaiting', `named, last 60d · ${open.length} open total`));
  pane.append(tiles);

  // competencies across every rating anyone gave you
  const comp = {};
  for (const x of scored) for (const it of x.v.items) {
    if (it.kind !== 'rating' || !(it.value > 0)) continue;
    (comp[competency(it.title)] ||= []).push((9 * it.value) / it.max);
  }
  const compRows = Object.entries(comp).map(([k, a]) => [k, mean(a), a.length]).sort((a, b) => b[1] - a[1]);
  const lowest = compRows.filter(([k]) => k !== 'Overall').at(-1);

  // comments
  const comments = [];
  for (const x of completed) for (const it of x.v?.items || []) {
    if (it.kind === 'text' && realText(it.value)) comments.push({ x, it, kind: commentKind(it.title) });
  }

  // act on this
  const act = el('div', 'act');
  const lines = [];
  if (lowest) lines.push(`Lowest-rated area: ${lowest[0]} (${f1(lowest[1])}/9).`);
  const improve = comments.filter(c => c.kind === 'improve');
  if (improve.length) lines.push(`${improve.length} “areas to improve” comments, newest below.`);
  if (unopened.length) lines.push(`${unopened.length} not opened yet. Opening one tells e-value you read it.`);
  if (lines.length) {
    act.append(el('div', 'act-title', 'Act on this'));
    for (const l of lines) act.append(el('div', 'act-text', l));
    for (const c of improve.slice(0, 3)) act.append(quote(c));
    pane.append(act);
  }

  if (scored.length > 1) {
    const s = sec('Trend', 'avg rating per evaluation, oldest → newest');
    s.append(spark(scored.map(x => x.s)));
    pane.append(s);
  }

  if (compRows.length) {
    const s = sec('By competency', 'all ratings, on a 9-point scale');
    for (const [k, avg, n] of compRows) s.append(bar(k, avg, 9, `${f1(avg)} · ${n}`, lowest && k === lowest[0]));
    pane.append(s);
  }

  const miles = completed.filter(x => x.v && isMilestone(x.r));
  if (miles.length) {
    const [last, prev] = miles;
    const prevBy = Object.fromEntries((prev?.v.items || []).filter(it => it.kind === 'rating').map(it => [it.title, it.value]));
    const items = last.v.items.filter(it => it.kind === 'rating');
    const low = [...items].sort((a, b) => a.value - b.value).slice(0, 3).map(it => it.title);
    const s = sec('Milestones', `${fmtDate(last.d)}${prev ? ` · vs ${fmtDate(prev.d)}` : ''} · lowest 3 flagged`);
    for (const it of items) {
      const p = prevBy[it.title];
      const d = p != null ? it.value - p : 0;
      s.append(bar(it.title, it.value, it.max,
        `${it.value}${d ? ` ${d > 0 ? '▲' : '▼'}${Math.abs(d)}` : ''}`, low.includes(it.title)));
    }
    pane.append(s);
  }

  if (open.length) {
    const s = sec('Still with evaluators', 'named, last 60 days');
    for (const r of nudgeable) {
      const req = toDate(r.requested);
      s.append(row(r.evaluator, [aboutKind(r.type), r.activity].filter(Boolean).join(' · '),
        `${daysBetween(req, now)}d`, () => toast(`Requested ${fmtDate(req)}${r.role ? ` · ${r.role}` : ''}`), 'static'));
    }
    const rest = open.length - nudgeable.length;
    if (rest) s.append(el('p', 'muted small pad', `${nudgeable.length ? '+ ' : ''}${rest} older or anonymous ${rest === 1 ? 'request' : 'requests'} e-value still shows as open.`));
    pane.append(s);
  }

  if (comments.length) {
    const s = sec('What they said', `${comments.length} comments`);
    const counts = k => comments.filter(c => c.kind === k).length;
    s.append(chips([['improve', `To improve ${counts('improve')}`], ['strength', `Strengths ${counts('strength')}`],
      ['general', `Other ${counts('general')}`], ['all', 'All']], commentFilter, k => { commentFilter = k; renderAbout(); }));
    const list = comments.filter(c => commentFilter === 'all' || c.kind === commentFilter);
    capped(s, 'comments', list, 6, quote);
    if (!list.length) s.append(el('p', 'muted small', 'Nothing here yet.'));
    pane.append(s);
  }

  const s = sec('All evaluations');
  s.id = 'about-list';
  s.append(chips([['all', `All ${completed.length}`], ['new', `Not opened ${unopened.length}`]], aboutFilter, k => { aboutFilter = k; renderAbout(); }));
  capped(s, 'evals', completed.filter(x => aboutFilter === 'all' || (x.r.tok && !x.r.viewed)), 12, x => {
    const sc = isMilestone(x.r) ? null : score9(x.v);
    return row(anon(x.r.evaluator), [aboutKind(x.r.type), /suppressed/i.test(x.r.activity) ? '' : x.r.activity, fmtDate(x.d)].filter(Boolean).join(' · '),
      x.r.tok ? (sc != null ? f1(sc) : '›') : 'locked', x.r.tok ? () => openViewer('about', x.r) : () => toast('e-value doesn’t release this one to you yet.'),
      (x.r.tok && !x.r.viewed ? 'new' : '') + (x.r.tok ? '' : ' static'));
  });
  pane.append(s);
}

/** First n items, then a "Show all" button that re-renders with everything (per list, until reload). */
const showAll = {};
function capped(parent, key, items, n, render) {
  for (const it of showAll[key] ? items : items.slice(0, n)) parent.append(render(it));
  if (!showAll[key] && items.length > n) {
    const b = el('button', 'btn ghost more', `Show all ${items.length}`);
    b.type = 'button';
    b.addEventListener('click', () => { showAll[key] = true; renderAll(); });
    parent.append(b);
  }
}

function quote(c) {
  const q = el('button', 'quote');
  q.type = 'button';
  q.append(el('div', 'quote-text', c.it.value),
    el('div', 'quote-by', [anon(c.x.r.evaluator), c.it.title.replace(/:$/, ''), fmtDate(c.x.d)].filter(Boolean).join(' · ')));
  q.addEventListener('click', () => openViewer('about', c.x.r));
  return q;
}

function renderAll() {
  renderList();
  renderDone();
  renderAbout();
  const unopened = about.filter(r => r.completed && r.tok && !r.viewed).length;
  for (const [id, n] of [['todo-badge', evals.length], ['about-badge', unopened]]) {
    $(id).textContent = n;
    $(id).classList.toggle('hidden', !n);
  }
}

// ---------- read-only viewer ----------
async function openViewer(src, r) {
  const key = keyOf(src, r);
  try {
    if (!views[key]) {
      toast('Opening…', 1500);
      await fetchViews(src, [r]);
    }
    const v = views[key];
    if (!v) throw new Error('Couldn’t read this evaluation.');
    const kind = src === 'done' ? evKind(r) : null;
    $('v-kind').textContent = src === 'done' ? KIND[kind] : aboutKind(r.type);
    $('v-kind').className = 'chip' + (kind ? ` k-${kind}` : '');
    $('v-title').textContent = src === 'done' ? (kind === 'rot' ? r.activity : r.subject) : anon(r.evaluator);
    $('v-meta').textContent = [src === 'about' && !/suppressed/i.test(r.activity) ? r.activity : '', r.period && !/suppressed/i.test(r.period) ? r.period : '',
      `submitted ${fmtDate(toDate(r.completed))}`].filter(Boolean).join(' · ');
    const body = $('v-body');
    body.replaceChildren();
    for (const it of v.items) {
      if (it.kind === 'text' && !realText(it.value)) continue;
      const q = el('section', 'q');
      q.append(el('h4', null, it.title || 'Question'));
      if (it.kind === 'rating') q.append(it.value > 0 ? bar('', it.value, it.max) : el('p', 'muted small', 'N/A'));
      else if (it.kind === 'choice') q.append(el('p', 'v-choice', it.value || '–'));
      else q.append(el('p', 'v-text', it.value));
      body.append(q);
    }
    if (!body.children.length) body.append(el('p', 'muted center', 'No answers on this one.'));
    body.scrollTop = 0;
    $('viewer').classList.remove('hidden');
    document.body.classList.add('locked');
    if (src === 'about' && !r.viewed) { // what e-value does when you open it: log "viewed by trainee"
      api('/seen', { method: 'POST', body: { tok: r.tok } }).then(() => {
        r.viewed = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        store.set('about', about);
        renderAll();
      }).catch(() => {});
    }
  } catch (err) {
    toast(err.message);
  }
}
function closeViewer() {
  $('viewer').classList.add('hidden');
  if ($('sheet').classList.contains('hidden')) document.body.classList.remove('locked');
}

// ---------- review sheet ----------
async function openReview(ev, vibe, btn) {
  btn?.classList.add('pulse');
  try {
    const form = forms[ev.eimnum] || (forms[ev.eimnum] = await api('/form', { params: evIds(ev) }));
    if (!form.items.length) throw new Error('Couldn’t read this form — finish it on e-value.');
    open = { ev, form, vibe, answers: generate(ev, form, vibe), armed: false };
    renderSheet();
    $('sheet').classList.remove('hidden');
    document.body.classList.add('locked');
  } catch (err) {
    toast(err.message);
  } finally {
    btn?.classList.remove('pulse');
  }
}

function closeSheet() {
  $('sheet').classList.add('hidden');
  document.body.classList.remove('locked');
  open = null;
}

function renderSheet() {
  const { ev, form, vibe } = open;
  const kind = evKind(ev);
  $('s-kind').textContent = KIND[kind];
  $('s-kind').className = `chip k-${kind}`;
  $('s-subject').textContent = kind === 'rot' ? ev.activity || ev.subject : (form.info.Subject || ev.subject).split(',')[0];
  $('s-meta').textContent = [form.info['Time Period'] || ev.period, form.info.Procedure, ev.site].filter(Boolean).join(' · ');
  $('s-vibes').replaceChildren(...vibeRow(v => { open.vibe = v; open.answers = generate(ev, form, v); renderSheet(); }, kind, vibe).childNodes);
  $('s-vibes').className = 'vibes compact';

  const body = $('s-body');
  body.replaceChildren();
  for (const it of form.items) {
    if (it.kind === 'date' && !it.mandatory) continue; // the "pearls" link-out date box
    const q = el('section', 'q');
    const head = el('div', 'q-head');
    head.append(el('h4', null, it.title || 'Question'));
    if (it.mandatory) head.append(el('span', 'req', 'required'));
    if (it.confidential) head.append(el('span', 'req conf', 'confidential'));
    q.append(head);
    if (it.prompt) {
      const p = el('p', 'q-prompt', it.prompt);
      p.addEventListener('click', () => p.classList.toggle('full'));
      q.append(p);
    }

    if (it.kind === 'choice') {
      const scale = ratingScale(it);
      const pills = el('div', 'pills' + (scale ? ' scale' : ''));
      if (scale) pills.style.gridTemplateColumns = `repeat(${it.options.length > 6 ? Math.ceil(it.options.length / 2) : it.options.length}, 1fr)`;
      for (const o of it.options) {
        const b = el('button', 'pill' + (open.answers[it.name] === o.v ? ' on' : ''),
          o.v === '0' && NA_RE.test(o.l) ? 'N/A' : o.l.replace(/^(\d+)\s+/, '$1 · '));
        b.type = 'button';
        b.addEventListener('click', () => {
          open.answers[it.name] = o.v;
          for (const x of pills.children) x.classList.toggle('on', x === b);
          q.classList.remove('need');
          updateFoot();
        });
        pills.append(b);
      }
      q.append(pills);
    } else if (it.kind === 'text') {
      const wrap = el('div', 'ta-wrap');
      const ta = el('textarea');
      ta.rows = 2;
      ta.value = open.answers[it.name] || '';
      ta.placeholder = it.confidential ? 'Left blank on purpose — optional' : 'Type or 🎲';
      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
      ta.addEventListener('input', () => { open.answers[it.name] = ta.value; grow(); q.classList.remove('need'); updateFoot(); });
      wrap.append(ta);
      if (!it.confidential) {
        const dice = el('button', 'dice', '🎲');
        dice.type = 'button';
        dice.setAttribute('aria-label', 'Rewrite this comment');
        dice.addEventListener('click', () => {
          ta.value = open.answers[it.name] = writeComment(it, evKind(ev), open.vibe, varsFor(ev, form));
          dice.classList.remove('roll'); void dice.offsetWidth; dice.classList.add('roll');
          grow(); updateFoot();
        });
        wrap.append(dice);
      }
      q.append(wrap);
      requestAnimationFrame(grow);
    } else if (it.kind === 'date') {
      const inp = el('input');
      inp.type = 'text';
      inp.value = open.answers[it.name] || '';
      inp.placeholder = 'MM/DD/YYYY';
      inp.addEventListener('input', () => { open.answers[it.name] = inp.value; updateFoot(); });
      q.append(inp);
    } else {
      q.append(el('p', 'warn', it.mandatory ? 'This question type isn’t supported here — finish this one on e-value.' : 'Skipped (not supported here).'));
    }
    if (it.mandatory && !String(open.answers[it.name] || '').trim()) q.classList.add('need');
    body.append(q);
  }
  body.scrollTop = 0;
  updateFoot();
}

function updateFoot() {
  const missing = needsYou(open.form, open.answers);
  const blocked = open.form.items.some(it => it.kind === 'unsupported' && it.mandatory);
  disarm();
  $('save-draft').disabled = false;
  $('submit').disabled = !!missing.length || blocked;
  $('s-status').textContent = blocked ? 'Needs e-value for one question.'
    : missing.length ? `${missing.length} ${missing.length === 1 ? 'question needs' : 'questions need'} a tap from you`
      : 'Looks good. Submit is final — e-value locks it and may notify people.';
}

let armTimer = null;
function disarm() {
  clearTimeout(armTimer);
  if (!open) return;
  open.armed = false;
  $('submit').classList.remove('armed');
  $('submit').textContent = 'Submit';
}

async function send(final) {
  if (final && !open.armed) { // first tap arms, second tap sends
    open.armed = true;
    $('submit').classList.add('armed');
    $('submit').textContent = 'Tap again to send — final';
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  const { ev, form, answers } = open;
  clearTimeout(armTimer);
  for (const b of [$('submit'), $('save-draft')]) b.disabled = true;
  $('s-status').textContent = final ? 'Sending to e-value…' : 'Saving draft…';
  try {
    const d = await api('/close', { method: 'POST', body: { ...evIds(ev), answers, final } });
    for (const it of form.items) if (it.kind === 'choice' && !ratingScale(it) && answers[it.name]) memo[qid(it.name)] = answers[it.name];
    store.set('memo', memo);
    if (final) {
      evals = evals.filter(e => e.eimnum !== ev.eimnum);
      store.set('evals', evals);
      delete forms[ev.eimnum];
    } else {
      delete forms[ev.eimnum]; // re-read so the draft shows next time
    }
    closeSheet();
    renderAll();
    toast(final ? `Sent ✓ ${d.message || ''}` : 'Draft saved in e-value — still editable.');
  } catch (err) {
    $('save-draft').disabled = false;
    updateFoot();
    $('s-status').textContent = err.message;
  }
}

// ---------- boot ----------
// ---------- pre-launch: you're early ----------
/** Procedural rave on WebAudio: four-on-the-floor, saw bass, square-lead random walk.
 *  Key, scale and tempo mutate every 4 bars. onBar(n) fires on each bar. */
function rave(onBar) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const master = ac.createGain();
  master.gain.value = 0.9;
  const comp = ac.createDynamicsCompressor();
  master.connect(comp).connect(ac.destination);
  const SCALES = [[0, 3, 5, 7, 10], [0, 1, 4, 5, 7, 8, 10], [0, 2, 4, 6, 7, 9, 11], [0, 2, 3, 7, 8], [0, 3, 6, 9]];
  let root, scale, bpm, bass;
  const mutate = () => {
    root = 36 + Math.floor(Math.random() * 8);
    scale = pick(SCALES);
    bpm = 140 + Math.random() * 45;
    bass = Array.from({ length: 4 }, () => Math.floor(Math.random() * 5));
  };
  mutate();
  const hz = m => 440 * 2 ** ((m - 69) / 12);
  const note = d => root + scale[((d % scale.length) + scale.length) % scale.length] + 12 * Math.floor(d / scale.length);
  const noise = ac.createBuffer(1, ac.sampleRate / 2, ac.sampleRate);
  noise.getChannelData(0).forEach((_, i, a) => { a[i] = Math.random() * 2 - 1; });

  function voice(src, t, dur, vol, filter) {
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    (filter ? src.connect(filter).connect(g) : src.connect(g)).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
    return src;
  }
  const tone = (type, f, t, dur, vol, fEnd) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    return voice(o, t, dur, vol);
  };
  const hiss = (t, dur, vol, type, freq) => {
    const s = ac.createBufferSource();
    s.buffer = noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    return voice(s, t, dur, vol, f);
  };

  let step = 0, next = ac.currentTime + 0.1, lead = 7;
  const timer = setInterval(() => {
    while (next < ac.currentTime + 0.15) {
      const s16 = 60 / bpm / 4, i = step % 16, bar = Math.floor(step / 16);
      if (i === 0) {
        if (bar && bar % 4 === 0) mutate();
        onBar(bar);
      }
      if (i % 4 === 0) tone('sine', 160, next, 0.22, 1, 38);                        // kick
      if (i === 4 || i === 12) { hiss(next, 0.18, 0.5, 'bandpass', 1800); tone('triangle', 190, next, 0.1, 0.3); } // snare
      if (i % 2) hiss(next, 0.05, Math.random() < 0.3 ? 0.35 : 0.18, 'highpass', 7500); // hats
      if (i % 2 === 0) tone('sawtooth', hz(note(bass[bar % 4])), next, s16 * 1.7, 0.3); // bass
      lead = Math.max(0, Math.min(18, lead + pick([-3, -2, -1, 1, 1, 2, 3])));
      if (Math.random() < 0.8) tone('square', hz(note(lead) + 24), next, s16 * 0.9, 0.12); // lead
      if (i === 0 && Math.random() < 0.5) tone('sawtooth', hz(note(lead) + 36), next, s16 * 8, 0.06, hz(note(lead) + 24)); // siren
      next += s16;
      step++;
    }
  }, 25);
  return {
    wake: () => ac.resume(),
    duck: on => master.gain.setTargetAtTime(on ? 0.3 : 0.9, ac.currentTime, 0.08),
    stop: () => { clearInterval(timer); ac.close(); },
  };
}

const TRIP_EMOJI = ['🤪', '🌀', '🍄', '🦄', '👁️', '🛸', '🫠', '🐸', '🌈', '🧠', '🪩', '👽'];
let tripping = null;

/** Anyone logging in before launch gets this instead. */
function trip() {
  if (tripping) return;
  const ov = el('div', 'trip');
  const emo = el('div', 'trip-emo', '🤪');
  const stop = el('button', 'trip-stop', 'make it stop');
  stop.type = 'button';
  ov.append(emo, el('div', 'trip-msg', 'YOU’RE EARLY'), el('div', 'trip-sub', 'Come back mid-November 2026'), stop);
  document.body.append(ov);

  const shout = () => {
    if (!('speechSynthesis' in window) || speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance('Youuu’re earlyyyy!! Come back later!!');
    u.pitch = 0;
    u.rate = 0.55;
    u.voice = speechSynthesis.getVoices().find(v => /^en/i.test(v.lang) && /david|daniel|fred|alex|guy|male/i.test(v.name)) || null;
    u.onstart = () => music.duck(true);
    u.onend = () => music.duck(false);
    speechSynthesis.speak(u);
  };
  const music = rave(bar => {
    emo.textContent = pick(TRIP_EMOJI);
    if (bar % 4 === 0) shout();
  });
  ov.addEventListener('click', () => music.wake()); // in case the browser started audio suspended
  tripping = {
    stop() {
      music.stop();
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      ov.remove();
      tripping = null;
      $('l-status').textContent = 'Not yet. Drop your email up top and we’ll tell you when.';
    },
  };
  stop.addEventListener('click', e => { e.stopPropagation(); tripping.stop(); });
}

function notified(email) {
  $('notify-form').classList.add('done');
  $('n-status').textContent = `You’re on the list ✓ We’ll email ${email}.`;
}

function wire() {
  $('notify-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('n-email').value.trim();
    $('n-go').disabled = true;
    $('n-status').textContent = '';
    try {
      await api('/notify', { method: 'POST', body: { email } });
      store.set('notified', email);
      notified(email);
    } catch (err) {
      $('n-status').textContent = err.message;
    } finally {
      $('n-go').disabled = false;
    }
  });
  if (store.get('notified')) notified(store.get('notified'));
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!store.get('beta')) return trip(); // pre-launch: credentials never leave the device
    settings.username = $('l-user').value.trim();
    settings.password = $('l-pass').value;
    $('l-go').disabled = true;
    $('l-status').textContent = 'Signing in to e-value…';
    try {
      await login();
      store.set('settings', settings);
      show('inbox');
      renderAll();
      refresh();
    } catch (err) {
      if (err.message === 'NOT_YET') return trip();
      $('l-status').textContent = err.message === 'INVALID_CREDENTIALS' ? 'That login didn’t work.' : err.message;
    } finally {
      $('l-go').disabled = false;
    }
  });
  $('refresh').addEventListener('click', refresh);
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });
  $('reroll').addEventListener('click', () => { open.answers = generate(open.ev, open.form, open.vibe); renderSheet(); });
  $('submit').addEventListener('click', () => send(true));
  $('save-draft').addEventListener('click', () => send(false));
  $('open-settings').addEventListener('click', () => { $('set-proxy').value = settings.proxy || DEFAULT_PROXY; $('settings').classList.remove('hidden'); });
  $('settings-close').addEventListener('click', () => {
    settings.proxy = $('set-proxy').value.trim() || DEFAULT_PROXY;
    store.set('settings', settings);
    $('settings').classList.add('hidden');
  });
  $('forget-answers').addEventListener('click', () => { memo = {}; store.set('memo', memo); toast('Forgot remembered answers.'); });
  $('logout').addEventListener('click', () => {
    for (const k of ['settings', 'session', 'evals', 'done', 'about', 'views', 'tab']) store.del(k);
    location.reload();
  });
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('click', e => { if (e.target === $('viewer')) closeViewer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeViewer(); closeSheet(); $('settings').classList.add('hidden'); } });
}

// Pre-launch beta link: ?beta=<code> is remembered on this device, then dropped from the URL.
const betaParam = new URLSearchParams(location.search).get('beta');
if (betaParam) {
  store.set('beta', betaParam);
  history.replaceState(null, '', location.pathname);
}

wire();
setTab(tab);
if (settings.username && settings.password) {
  show('inbox');
  renderAll();
  refresh();
} else {
  show('login');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

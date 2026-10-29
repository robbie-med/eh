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
  const d = await api('/login', { method: 'POST', body: { username: settings.username, password: settings.password } }, true);
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
  $('subline').textContent = n ? 'Tap a vibe. We’ll write it, you glance, you send.' : 'Nothing pending in e-value. Go touch grass. 🌱';
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

async function refresh() {
  $('refresh').classList.add('spin');
  try {
    const d = await api('/evals');
    evals = d.evals || [];
    store.set('evals', evals);
    renderList();
    prefetch();
  } catch (err) {
    if (!evals.length) $('headline').textContent = 'Hmm.';
    $('subline').textContent = err.message;
  } finally {
    $('refresh').classList.remove('spin');
  }
}

// ponytail: one at a time, so the e-value session never sees parallel page loads
async function prefetch() {
  for (const ev of evals) {
    if (forms[ev.eimnum]) continue;
    try { forms[ev.eimnum] = await api('/form', { params: evIds(ev) }); } catch { /* fetched on tap instead */ }
  }
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
    renderList();
    toast(final ? `Sent ✓ ${d.message || ''}` : 'Draft saved in e-value — still editable.');
  } catch (err) {
    $('save-draft').disabled = false;
    updateFoot();
    $('s-status').textContent = err.message;
  }
}

// ---------- boot ----------
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
    settings.username = $('l-user').value.trim();
    settings.password = $('l-pass').value;
    $('l-go').disabled = true;
    $('l-status').textContent = 'Signing in to e-value…';
    try {
      await login();
      store.set('settings', settings);
      show('inbox');
      refresh();
    } catch (err) {
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
    for (const k of ['settings', 'session', 'evals']) store.del(k);
    location.reload();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); $('settings').classList.add('hidden'); } });
}

wire();
if (settings.username && settings.password) {
  show('inbox');
  renderList();
  refresh();
} else {
  show('login');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(function () {
  'use strict';

  var $app = document.getElementById('app');
  var $toast = document.getElementById('toast');

  /* ---------- helpers ---------- */
  var L = function (i) { return String.fromCharCode(65 + i); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (ms) {
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  var num = function (x) { return Number.isInteger(x) ? String(x) : x.toFixed(1); };
  var sign = function (n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function loadSession() {
    try { return JSON.parse(lsGet('thinkage.session')); } catch (e) { return null; }
  }

  /* ---------- state ---------- */
  var ws = null;
  var S = null; // latest state from the server
  var localEnd = 0;
  var conn = false;
  var retry = 0;
  var rejoining = !!loadSession();
  var lastHtml = '';
  var ui = { name: lsGet('thinkage.name') || '', code: '', round: -1, pick: null, clue: '', sel: {}, star: {}, target: null };

  function nm(id) {
    var p = S && S.players.filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '?';
  }
  var isHost = function () { return S && S.hostId === S.you; };

  /* ---------- connection ---------- */
  function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }
  function connect() {
    if (ws && ws.readyState <= 1) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = function () {
      conn = true;
      retry = 0;
      var s = loadSession();
      if (s) send({ t: 'rejoin', code: s.code, token: s.token });
      else rejoining = false;
      render();
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      onMsg(m);
    };
    ws.onclose = function () {
      conn = false;
      render();
      retry++;
      setTimeout(connect, Math.min(4000, 400 + retry * 600));
    };
    ws.onerror = function () {};
  }
  setInterval(function () { send({ t: 'ping' }); }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      connect();
      if (S && (S.phase === 'link' || S.phase === 'think')) getWake();
    }
  });

  function onMsg(m) {
    if (m.t === 'joined') {
      lsSet('thinkage.session', JSON.stringify({ code: m.code, token: m.token }));
    } else if (m.t === 'gone') {
      lsDel('thinkage.session');
      S = null;
      rejoining = false;
      render();
    } else if (m.t === 'error') {
      if (rejoining) { rejoining = false; render(); }
      toast(m.msg);
    } else if (m.t === 'state') {
      var prev = S;
      S = m.state;
      rejoining = false;
      if (S.timer) localEnd = Date.now() + S.timer.remainingMs;
      if (S.round !== ui.round) {
        ui.round = S.round;
        ui.pick = null;
        ui.clue = '';
        ui.sel = {};
        ui.star = {};
        ui.target = null;
      }
      var timed = function (p) { return p === 'link' || p === 'think'; };
      if (prev && timed(prev.phase) && !timed(S.phase) && S.endReason === 'time') beep();
      if (timed(S.phase)) getWake(); else dropWake();
      render();
    }
  }

  /* ---------- sound, vibration, wake lock, toast ---------- */
  var audio = null;
  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    if (!audio) return;
    try {
      [0, 0.28, 0.56].forEach(function (d) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        o.connect(g);
        g.connect(audio.destination);
        var t = audio.currentTime + d;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t);
        o.stop(t + 0.25);
      });
    } catch (e) {}
  }
  var wake = null;
  function getWake() {
    try {
      if (!wake && navigator.wakeLock && document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').then(function (w) {
          wake = w;
          w.addEventListener('release', function () { wake = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function dropWake() {
    try { if (wake) wake.release(); } catch (e) {}
    wake = null;
  }
  var toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 3200);
  }

  /* ---------- guess helpers ---------- */
  function letters(tid) {
    if (ui.sel[tid]) return ui.sel[tid];
    var g = S.me.guesses[tid];
    return g ? [g.a, g.b] : [];
  }
  function starOf(tid) {
    if (ui.star[tid] !== undefined) return ui.star[tid];
    var g = S.me.guesses[tid];
    return !!(g && g.star);
  }
  var validClue = function (c) { return /^\S{1,30}$/.test(String(c).trim()); };

  /* ---------- screens ---------- */
  function header() {
    var t = S.timer;
    var h = '<header class="top"><div class="top-row"><span class="rd">Round ' + S.round + ' of ' + S.rounds + '</span>' +
      '<span class="pill">' + (S.phase === 'link' ? 'Link' : 'Think') + '</span><span class="sp"></span>' +
      '<span class="clock js-time"></span></div>' +
      '<div class="bar"><i class="js-bar"></i></div>';
    if (t.paused) h += '<div class="pausedbanner">Paused</div>';
    if (isHost()) h += '<div class="top-row"><span class="sp"></span><button class="mini" data-act="' + (t.paused ? 'resume' : 'pause') + '">' + (t.paused ? 'Resume clock' : 'Pause clock') + '</button></div>';
    return h + '</header>';
  }

  function screenRejoin() {
    return '<main class="screen"><h1 class="brand">Thinkage</h1><p class="muted">Rejoining your game…</p></main>';
  }

  function screenHome() {
    return '<main class="screen">' +
      '<div><div class="lab">Party game</div><h1 class="brand">Thinkage</h1></div>' +
      '<p class="muted">Link two words with one clue, then work out which words your friends linked. Everyone plays on their own phone.</p>' +
      '<div class="field"><label for="name">Your name</label><input id="name" class="input" maxlength="14" autocomplete="off" value="' + esc(ui.name) + '"></div>' +
      '<button class="btn primary big" data-act="create">Start a new game</button>' +
      '<div class="divider">or join a friend’s game</div>' +
      '<div class="field"><label for="code">Game code</label><input id="code" class="input code" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABCD" value="' + esc(ui.code) + '"></div>' +
      '<button class="btn" data-act="join">Join game</button>' +
      '</main>';
  }

  function screenLobby() {
    var host = isHost();
    var n = S.players.length;
    var secs = S.times[n];
    var list = S.players.map(function (p) {
      var tags = '';
      if (p.id === S.hostId) tags += '<span class="tag">Host</span>';
      if (p.id === S.you) tags += '<span class="tag">You</span>';
      var kick = host && p.id !== S.you ? '<button class="mini" data-act="kick" data-id="' + p.id + '">Remove</button>' : '';
      return '<li><span class="dot ' + (p.online ? '' : 'off') + '"></span><span class="nm">' + esc(p.name) + (p.online ? '' : ' <span class="muted small">(offline)</span>') + '</span>' + tags + kick + '</li>';
    }).join('');
    var ws_ = S.wordsets.map(function (w) {
      return '<label class="' + (S.wordset === w.key ? 'on' : '') + '"><input type="radio" name="wordset" data-act="wordset" data-v="' + w.key + '"' + (S.wordset === w.key ? ' checked' : '') + '><span>' + esc(w.name) + '</span></label>';
    }).join('');
    var current = S.wordsets.filter(function (w) { return w.key === S.wordset; })[0];
    return '<main class="screen">' +
      '<div><div class="lab center">Game code</div><div class="roomcode">' + esc(S.code) + '</div>' +
      '<p class="muted small center">Friends open <b>' + esc(location.host) + '</b> and enter this code.</p></div>' +
      '<section class="field"><h2>Players (' + n + ' of ' + S.maxPlayers + ')</h2><ul class="plist">' + list + '</ul></section>' +
      (host ? '<section class="field"><h2>Word list</h2><div class="seg">' + ws_ + '</div></section>'
            : '<p class="muted">Word list: <b>' + esc(current ? current.name : '') + '</b></p>') +
      '<p class="muted small">' + (secs ? 'The clock for ' + n + ' players is ' + fmt(secs * 1000) + ' per round. It covers linking and thinking together.' : 'Thinkage needs 3 to 6 players.') + '</p>' +
      '<details class="card"><summary>How a round works</summary><div class="small muted" style="display:grid;gap:6px;margin-top:8px">' +
      '<p><b>Link.</b> You get a secret word. Pick a second word from the list and type one clue word that links the two.</p>' +
      '<p><b>Think.</b> Once everyone has linked, you see everyone else’s clue. Guess which two words each player linked. Star a guess you’re sure of.</p>' +
      '<p><b>Scoring.</b> Right guess +1. Right and starred +2. Wrong and starred −1. Your team score is judged at the end of round 3.</p></div></details>' +
      (host ? '<button class="btn primary big" data-act="start"' + (n < S.minPlayers ? ' disabled' : '') + '>' + (n < S.minPlayers ? 'Need at least 3 players' : 'Start game') + '</button>'
            : '<p class="muted center">Waiting for the host to start…</p>') +
      '<button class="link" data-act="leave">Leave game</button>' +
      '</main>';
  }

  function screenLink() {
    var me = S.me;
    var words = S.words;
    var sub = me.pick !== null;
    var yours = '<section class="card yours"><div class="lab">Your word</div><div class="big"><span class="ltr">' + L(me.assigned) + '</span><span>' + esc(words[me.assigned]) + '</span></div></section>';
    var body;
    var dock;
    if (!sub) {
      var rows = words.map(function (w, i) {
        if (i === me.assigned) {
          return '<li><button class="row own" disabled><span class="ltr">' + L(i) + '</span><span class="w">' + esc(w) + '</span><em>yours</em></button></li>';
        }
        return '<li><button class="row' + (ui.pick === i ? ' sel' : '') + '" data-act="pick" data-i="' + i + '"><span class="ltr">' + L(i) + '</span><span class="w">' + esc(w) + '</span></button></li>';
      }).join('');
      body = '<h2>Pick a second word to link to yours</h2><ul class="wl">' + rows + '</ul>';
      var ok = ui.pick !== null && validClue(ui.clue);
      dock = '<div class="dock"><div class="line">' +
        (ui.pick !== null ? 'Link <b>' + esc(words[me.assigned]) + '</b> and <b>' + esc(words[ui.pick]) + '</b>' : 'Tap a word above, then type your clue.') +
        '</div><div class="inrow"><input id="clue" class="input" maxlength="30" placeholder="One-word clue" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" value="' + esc(ui.clue) + '">' +
        '<button class="btn primary" data-act="submit"' + (ok ? '' : ' disabled') + '>Lock in</button></div></div>';
    } else {
      var waiting = S.players.filter(function (p) { return !p.done; });
      body = '<section class="card"><div class="lab">Locked in</div>' +
        '<p style="margin-top:6px"><b>' + esc(words[me.assigned]) + '</b> + <b>' + esc(words[me.pick]) + '</b></p>' +
        '<div class="clueword" style="margin-top:6px">' + esc(me.clue) + '</div></section>' +
        '<section class="field"><h2>' + (waiting.length ? 'Waiting for ' + waiting.length + ' more' : 'Everyone is in') + '</h2>' +
        '<ul class="plist">' + S.players.map(function (p) {
          return '<li><span class="nm">' + esc(p.name) + '</span>' + (p.done ? '<span class="tick">✓</span>' : '<span class="muted small">linking…</span>') + '</li>';
        }).join('') + '</ul></section>';
      dock = '<div class="dock"><button class="btn" data-act="change">Change my link</button></div>';
    }
    return header() + '<main class="screen">' + yours + body + '</main>' + dock;
  }

  function screenThink() {
    var me = S.me;
    var words = S.words;
    if (!ui.target || !S.targets.some(function (t) { return t.id === ui.target; })) {
      var first = S.targets.filter(function (t) { return letters(t.id).length < 2; })[0] || S.targets[0];
      ui.target = first.id;
    }
    var cur = S.targets.filter(function (t) { return t.id === ui.target; })[0];
    var made = S.targets.filter(function (t) { return letters(t.id).length === 2; }).length;
    var all = made === S.targets.length;
    var tabs = S.targets.map(function (t) {
      var l = letters(t.id);
      var done = l.length === 2;
      return '<button class="tab' + (t.id === ui.target ? ' on' : '') + (done ? ' done' : '') + '" data-act="target" data-t="' + t.id + '"><span>' + esc(t.name) + '</span><small>' +
        (done ? l.map(L).join('+') + (starOf(t.id) ? ' ★' : '') : '—') + '</small></button>';
    }).join('');
    var sel = letters(cur.id);
    var rows = words.map(function (w, i) {
      return '<li><button class="row' + (sel.indexOf(i) >= 0 ? ' sel' : '') + '" data-act="word" data-i="' + i + '"' + (me.locked ? ' disabled' : '') + '><span class="ltr">' + L(i) + '</span><span class="w">' + esc(w) + '</span></button></li>';
    }).join('');
    var star = starOf(cur.id);
    var body = '<section class="card" style="display:grid;gap:6px"><div class="lab">You linked</div><p><b>' + esc(words[me.assigned]) + '</b> + <b>' + esc(words[me.pick]) + '</b> with “' + esc(me.clue) + '”</p></section>' +
      '<p class="legend">Pick a player, then tap the two words you think they linked. Star a guess you’re sure of: +2 if right, −1 if wrong.</p>' +
      '<div class="tabs">' + tabs + '</div>' +
      '<section class="card target"><div class="who"><span class="lab">' + esc(cur.name) + '’s clue</span></div><div class="clueword">' + esc(cur.clue) + '</div>' +
      '<ul class="wl">' + rows + '</ul>' +
      '<div class="tfoot"><span class="echo">' + (sel.length === 2 ? esc(words[sel[0]]) + ' + ' + esc(words[sel[1]]) : sel.length === 1 ? 'Pick one more word' : 'Pick two words') + '</span>' +
      '<button class="starbtn' + (star ? ' on' : '') + '" data-act="star"' + (me.locked ? ' disabled' : '') + '>★ ' + (star ? 'Starred' : 'Star') + '</button></div></section>';
    var dock;
    if (me.locked) {
      var waiting = S.players.filter(function (p) { return !p.done; }).map(function (p) { return p.name; });
      dock = '<div class="dock"><div class="line">' + (waiting.length ? 'Waiting for ' + esc(waiting.join(', ')) + '…' : 'Everyone is locked in.') + '</div><button class="btn" data-act="unlock">Change my guesses</button></div>';
    } else {
      dock = '<div class="dock"><div class="line">' + made + ' of ' + S.targets.length + ' guesses made</div><button class="btn primary big" data-act="lock"' + (all ? '' : ' disabled') + '>Lock in guesses</button></div>';
    }
    return header() + '<main class="screen">' + body + '</main>' + dock;
  }

  function screenVote() {
    var words = S.words;
    var pending = S.players.filter(function (p) { return !p.done; }).map(function (p) { return p.name; });
    var groups = S.vote.groups.map(function (g) {
      var clues = g.members.map(function (m) {
        return '<div><div class="lab">' + esc(m.name) + '</div><div class="clueword">' + esc(m.clue) + '</div></div>';
      }).join('');
      var action;
      if (g.canVote) {
        action = '<div class="vbtns"><button class="btn' + (g.myVote === true ? ' on' : '') + '" data-act="vote" data-g="' + g.id + '" data-s="1">Same</button>' +
          '<button class="btn' + (g.myVote === false ? ' on' : '') + '" data-act="vote" data-g="' + g.id + '" data-s="0">Different</button></div>';
      } else {
        action = '<p class="muted small">You’re in this pair, so the others decide.</p>';
      }
      return '<section class="card vgroup"><div><div class="lab">Both linked</div><p><b>' + esc(words[g.pair[0]]) + '</b> + <b>' + esc(words[g.pair[1]]) + '</b></p></div>' +
        '<div class="vclues">' + clues + '</div>' + action +
        '<p class="muted small">' + g.voted.length + ' of ' + g.voters.length + ' votes in</p></section>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + '</div><h2>Were these clues the same?</h2>' +
      '<p class="muted small" style="margin-top:6px">These players linked the same two words. If the clues are also the same, nobody scores that pair. A plural or a typo counts as the same clue. A tie counts as different.</p></div>' +
      groups +
      (pending.length ? '<p class="muted center small">Waiting for ' + esc(pending.join(', ')) + '</p>' : '') +
      (isHost() ? '<button class="btn" data-act="skipVotes">Continue without waiting</button>' : '') +
      '</main>';
  }

  function chip(guesserId, c) {
    if (!c) return '';
    var cls = c.status;
    var guess = c.status === 'none' ? 'no guess' : L(c.a) + '+' + L(c.b) + (c.star ? ' ★' : '');
    var tail = '';
    if (c.note === 'void') { cls = 'void'; tail = '<small>void</small>'; }
    else if (c.note === 'once') tail = '<small>counted once</small>';
    else if (c.status !== 'none') tail = '<b>' + sign(c.pts) + '</b>';
    return '<span class="chip ' + cls + '">' + esc(nm(guesserId)) + ' <small>' + guess + '</small> ' + tail + '</span>';
  }

  function screenResults() {
    var R = S.results;
    var words = S.words;
    var last = S.round >= S.rounds;
    var btn = isHost()
      ? '<button class="btn primary big" data-act="next">' + (last ? 'See final result' : 'Next round') + '</button>'
      : '<p class="muted center">Waiting for the host…</p>';
    if (R.failedLink) {
      var missing = R.linkStatus.filter(function (x) { return !x.submitted; }).map(function (x) { return nm(x.id); });
      return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + '</div><h2>Time ran out while linking</h2></div>' +
        '<section class="card"><p>There was no Think phase this round, so the team scores <b>0</b>.</p>' +
        (missing.length ? '<p class="muted small" style="margin-top:6px">Still linking: ' + esc(missing.join(', ')) + '</p>' : '') +
        '<p class="muted small" style="margin-top:6px">The clock covers linking and thinking together. Linking quickly leaves more time to think.</p></section>' +
        scoreCard() + btn + '</main>';
    }
    var cards = R.targets.map(function (t) {
      var chips = S.players.filter(function (p) { return p.id !== t.id; }).map(function (p) {
        return chip(p.id, R.cells[t.id] && R.cells[t.id][p.id]);
      }).join('');
      var note = '';
      if (t.group !== null) {
        var g = R.groups.filter(function (x) { return x.id === t.group; })[0];
        var others = g.members.filter(function (m) { return m !== t.id; }).map(nm).join(', ');
        note = '<p class="note">Same pair as ' + esc(others) + '. Clues judged ' + (g.same ? 'the same' : 'different') + ' (' + g.yes + '–' + g.no + '). ' +
          (g.same ? 'Nobody scores this pair.' : 'Each guesser scores this pair once.') + '</p>';
      }
      return '<section class="card" style="display:grid;gap:10px"><div><div class="lab">' + esc(t.name) + '’s clue</div><div class="clueword">' + esc(t.clue) + '</div></div>' +
        '<div class="pair"><span><span class="ltr">' + L(t.assigned) + '</span> ' + esc(words[t.assigned]) + ' <span class="muted small">(given)</span></span>' +
        '<span><span class="ltr">' + L(t.pick) + '</span> ' + esc(words[t.pick]) + ' <span class="muted small">(picked)</span></span></div>' +
        note + '<div class="chips">' + chips + '</div></section>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + (R.reason === 'time' ? ' · time ran out' : '') + '</div><h2>Round results</h2></div>' +
      scoreCard() + cards + btn + '</main>';
  }

  function scoreCard() {
    var R = S.results;
    var sc = S.score;
    var rows = S.players.map(function (p) {
      var pts = R.points[p.id] || 0;
      return '<div class="stat"><span>' + esc(p.name) + '</span><span class="mono">' + sign(pts) + ' <span class="muted">· ' + sc.byPlayer[p.id].total + ' total</span></span></div>';
    }).join('');
    return '<section class="card"><div class="lab">Team points this round</div><div class="big-score">' + sign(R.teamPoints) + '</div>' +
      '<div style="margin-top:10px">' + rows + '</div></section>';
  }

  function screenOver() {
    var sc = S.score;
    var rounds = [];
    for (var r = 0; r < S.rounds; r++) {
      var t = 0;
      S.players.forEach(function (p) { t += sc.byPlayer[p.id].rounds[r] || 0; });
      rounds.push('<div class="stat"><span>Round ' + (r + 1) + '</span><span class="mono">' + sign(t) + '</span></div>');
    }
    var players = S.players.map(function (p) {
      return '<div class="stat"><span>' + esc(p.name) + '</span><span class="mono">' + sc.byPlayer[p.id].total + '</span></div>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Game over</div><h2>Team result</h2></div>' +
      '<section class="card" style="display:grid;gap:8px"><div class="rating">' + esc(sc.rating) + '</div>' +
      '<div class="big-score">' + sc.pct + '%</div>' +
      '<p class="muted">Your team scored <b>' + sc.team + '</b> of a possible <b>' + num(sc.perfect) + '</b>.</p></section>' +
      '<section class="card"><div class="lab">By round</div>' + rounds.join('') + '</section>' +
      '<section class="card"><div class="lab">By player</div>' + players + '</section>' +
      (isHost() ? '<button class="btn primary big" data-act="again">Play again</button>' : '<p class="muted center">Waiting for the host…</p>') +
      '<button class="link" data-act="leave">Leave game</button></main>';
  }

  /* ---------- render ---------- */
  function render() {
    var ae = document.activeElement;
    var keep = ae && ae.id && $app.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
    var sy = window.scrollY;
    var html;
    if (!S) html = rejoining ? screenRejoin() : screenHome();
    else if (S.phase === 'lobby') html = screenLobby();
    else if (S.phase === 'link') html = screenLink();
    else if (S.phase === 'think') html = screenThink();
    else if (S.phase === 'vote') html = screenVote();
    else if (S.phase === 'results') html = screenResults();
    else html = screenOver();
    var timed = S && (S.phase === 'link' || S.phase === 'think');
    $app.dataset.phase = timed ? S.phase : '';
    $app.classList.toggle('is-paused', !!(timed && S.timer.paused));
    var full = (conn ? '' : '<div class="conn">Reconnecting…</div>') + html;
    // Skip the rebuild when nothing visible changed, so a tap never lands on a replaced button.
    if (full === lastHtml) { tick(); return; }
    lastHtml = full;
    $app.innerHTML = full;
    if (keep) {
      var el = document.getElementById(keep.id);
      if (el) {
        el.focus();
        try { el.setSelectionRange(keep.s, keep.e); } catch (_) {}
      }
    }
    window.scrollTo(0, sy);
    tick();
  }

  function tick() {
    if (!S || !S.timer) return;
    var rem = S.timer.paused ? S.timer.remainingMs : Math.max(0, localEnd - Date.now());
    var els = document.querySelectorAll('.js-time');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = fmt(rem);
      els[i].classList.toggle('low', rem <= 10000);
    }
    var bars = document.querySelectorAll('.js-bar');
    for (var j = 0; j < bars.length; j++) {
      bars[j].style.transform = 'scaleX(' + Math.max(0, Math.min(1, rem / S.timer.total)) + ')';
    }
  }
  setInterval(tick, 200);

  /* ---------- actions ---------- */
  function submitClue() {
    if (ui.pick === null || !validClue(ui.clue)) return;
    send({ t: 'pick', pick: ui.pick, clue: ui.clue.trim() });
  }

  function toggleWord(i) {
    var tid = ui.target;
    var cur = letters(tid).slice();
    var k = cur.indexOf(i);
    if (k >= 0) cur.splice(k, 1);
    else {
      cur.push(i);
      if (cur.length > 2) cur.shift();
    }
    ui.sel[tid] = cur;
    if (cur.length === 2) send({ t: 'guess', target: tid, a: cur[0], b: cur[1], star: starOf(tid) });
    else send({ t: 'clear', target: tid });
    render();
  }

  function act(a, d) {
    switch (a) {
      case 'create':
        ui.name = ui.name.trim();
        if (!ui.name) return toast('Enter your name first.');
        lsSet('thinkage.name', ui.name);
        return send({ t: 'create', name: ui.name });
      case 'join':
        ui.name = ui.name.trim();
        if (!ui.name) return toast('Enter your name first.');
        if (ui.code.length !== 4) return toast('Enter the 4-letter game code.');
        lsSet('thinkage.name', ui.name);
        return send({ t: 'join', code: ui.code, name: ui.name });
      case 'leave':
        send({ t: 'leave' });
        lsDel('thinkage.session');
        S = null;
        ui.round = -1;
        return render();
      case 'kick': return send({ t: 'kick', id: d.id });
      case 'wordset': return send({ t: 'setWordset', wordset: d.v });
      case 'start': return send({ t: 'start' });
      case 'pause': return send({ t: 'pause' });
      case 'resume': return send({ t: 'resume' });
      case 'pick': ui.pick = Number(d.i); return render();
      case 'submit': return submitClue();
      case 'change':
        ui.pick = S.me.pick;
        ui.clue = S.me.clue || '';
        return send({ t: 'withdraw' });
      case 'target': ui.target = d.t; return render();
      case 'word': return toggleWord(Number(d.i));
      case 'star':
        ui.star[ui.target] = !starOf(ui.target);
        if (letters(ui.target).length === 2) {
          var s = letters(ui.target);
          send({ t: 'guess', target: ui.target, a: s[0], b: s[1], star: ui.star[ui.target] });
        }
        return render();
      case 'lock': return send({ t: 'lock' });
      case 'unlock': return send({ t: 'unlock' });
      case 'vote': return send({ t: 'vote', group: Number(d.g), same: d.s === '1' });
      case 'skipVotes': return send({ t: 'skipVotes' });
      case 'next': return send({ t: 'next' });
      case 'again': return send({ t: 'again' });
    }
  }

  $app.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    unlockAudio();
    act(b.dataset.act, b.dataset);
  });
  $app.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'name') ui.name = t.value;
    else if (t.id === 'code') {
      ui.code = t.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (t.value !== ui.code) t.value = ui.code;
    } else if (t.id === 'clue') {
      var clean = t.value.replace(/\s+/g, '');
      if (clean !== t.value) t.value = clean;
      ui.clue = clean;
      var btn = document.querySelector('[data-act="submit"]');
      if (btn) btn.disabled = !(ui.pick !== null && validClue(ui.clue));
    }
  });
  $app.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'clue') { e.preventDefault(); submitClue(); }
    else if (e.target.id === 'name' || e.target.id === 'code') {
      e.preventDefault();
      act(ui.code.length === 4 ? 'join' : 'create', {});
    }
  });

  render();
  connect();
})();

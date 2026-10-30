'use strict';
// Thinkage: room-based multiplayer server. One Node process, WebSockets, no database.
// Games live in memory, so a server restart ends any game in progress.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORDSETS = require('./words');

const PORT = Number(process.env.PORT) || 3000;
const SCALE = Number(process.env.TIME_SCALE) || 1; // tests shrink the clock
const ROUND_SECONDS = { 3: 120, 4: 140, 5: 160, 6: 180 };
const ROUNDS = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

const rooms = new Map();

/* ---------- small helpers ---------- */

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
const pairKey = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
const roundMs = n => ROUND_SECONDS[n] * 1000 * SCALE;
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14);

function rate(pct) {
  if (pct >= 90) return 'Excellent';
  if (pct >= 80) return 'Good';
  if (pct >= 70) return 'OK';
  if (pct >= 60) return 'Satisfactory';
  if (pct >= 50) return 'Were you really trying?';
  return 'Not good! Better luck next time.';
}

/* ---------- rooms and players ---------- */

function newRoom() {
  return {
    code: makeCode(),
    hostId: null,
    players: [],
    wordset: 'classic',
    phase: 'lobby', // lobby | link | think | vote | results | over
    round: 0,
    pool: [],
    poolIdx: 0,
    words: [],
    groups: [],
    results: null,
    endReason: null,
    paused: false,
    remainingMs: 0,
    endAt: 0,
    totalMs: 0,
    lastActive: Date.now()
  };
}

function addPlayer(room, name, ws) {
  const p = {
    id: newId(),
    token: newToken(),
    name,
    ws,
    online: true,
    assigned: null,
    pick: null,
    clue: null,
    guesses: {},
    locked: false,
    roundPoints: []
  };
  room.players.push(p);
  return p;
}

function resetPlayerRound(p) {
  p.pick = null;
  p.clue = null;
  p.guesses = {};
  p.locked = false;
}

function remaining(room) {
  return room.paused ? room.remainingMs : Math.max(0, room.endAt - Date.now());
}

/* ---------- game flow ---------- */

function startGame(room) {
  const set = WORDSETS[room.wordset];
  room.pool = shuffle(set.words.slice());
  room.poolIdx = 0;
  room.round = 0;
  room.players.forEach(p => {
    p.roundPoints = [];
  });
  startRound(room);
}

function startRound(room) {
  const n = room.players.length;
  const count = n <= 4 ? 10 : 12;
  room.round += 1;
  room.words = room.pool.slice(room.poolIdx, room.poolIdx + count);
  room.poolIdx += count;
  const order = shuffle([...Array(count).keys()]);
  room.players.forEach((p, i) => {
    resetPlayerRound(p);
    p.assigned = order[i];
  });
  room.groups = [];
  room.results = null;
  room.endReason = null;
  room.phase = 'link';
  room.totalMs = roundMs(n);
  room.paused = false;
  room.endAt = Date.now() + room.totalMs;
}

function startThink(room) {
  room.phase = 'think';
}

// The round clock ran out while someone was still linking: no Think phase, zero points.
function failLink(room) {
  const points = {};
  room.players.forEach(p => {
    points[p.id] = 0;
    p.roundPoints.push(0);
  });
  room.results = {
    failedLink: true,
    reason: 'time',
    teamPoints: 0,
    points,
    linkStatus: room.players.map(p => ({ id: p.id, submitted: p.pick !== null })),
    targets: [],
    groups: [],
    cells: {}
  };
  room.phase = 'results';
}

// Think is over (everyone locked in, or time ran out). Same-pair players trigger a vote.
function endThink(room) {
  const byKey = new Map();
  room.players.forEach(p => {
    if (p.pick === null) return;
    const k = pairKey(p.assigned, p.pick);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p.id);
  });
  room.groups = [];
  for (const [key, members] of byKey) {
    if (members.length > 1) {
      const [a, b] = key.split('-').map(Number);
      room.groups.push({ id: room.groups.length, key, pair: [a, b], members, votes: {}, same: null });
    }
  }
  if (room.groups.length) room.phase = 'vote';
  else finishRound(room);
}

function votesComplete(room) {
  return room.groups.every(g =>
    room.players.every(p => g.members.includes(p.id) || g.votes[p.id] !== undefined)
  );
}

function scoreRound(room) {
  const players = room.players;
  const subs = players.filter(p => p.pick !== null);
  const byKey = new Map();
  subs.forEach(p => {
    const k = pairKey(p.assigned, p.pick);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p.id);
  });
  const sameByKey = new Map(room.groups.map(g => [g.key, g.same]));
  const points = {};
  players.forEach(p => (points[p.id] = 0));
  const cells = {};
  subs.forEach(t => (cells[t.id] = {}));

  for (const g of players) {
    for (const [key, members] of byKey) {
      const targets = members.filter(m => m !== g.id);
      if (!targets.length) continue;
      const voided = members.length > 1 && sameByKey.get(key) === true;
      const evals = targets.map(tid => {
        const gs = g.guesses[tid];
        if (!gs) return { tid, status: 'none', star: false };
        return {
          tid,
          status: pairKey(gs.a, gs.b) === key ? 'correct' : 'wrong',
          star: !!gs.star,
          a: gs.a,
          b: gs.b
        };
      });
      // A pair shared by two players scores once per guesser: the best outcome counts.
      let carrier = null;
      let pts = 0;
      if (!voided) {
        const right = evals.filter(e => e.status === 'correct').sort((x, y) => Number(y.star) - Number(x.star));
        if (right.length) {
          carrier = right[0];
          pts = carrier.star ? 2 : 1;
        } else {
          const bad = evals.find(e => e.status === 'wrong' && e.star);
          if (bad) {
            carrier = bad;
            pts = -1;
          }
        }
      }
      evals.forEach(e => {
        const cell = { status: e.status, star: e.star, a: e.a, b: e.b, pts: 0, note: null };
        if (voided) cell.note = 'void';
        else if (e === carrier) cell.pts = pts;
        else if (members.length > 1 && e.status !== 'none' && carrier) cell.note = 'once';
        cells[e.tid][g.id] = cell;
      });
      points[g.id] += pts;
    }
  }
  return { points, cells };
}

function finishRound(room) {
  room.groups.forEach(g => {
    const vals = Object.values(g.votes);
    g.yes = vals.filter(v => v === true).length;
    g.no = vals.filter(v => v === false).length;
    g.same = g.yes > g.no; // a tie counts as "different"
  });
  const { points, cells } = scoreRound(room);
  let team = 0;
  room.players.forEach(p => {
    p.roundPoints.push(points[p.id]);
    team += points[p.id];
  });
  const groupOf = new Map();
  room.groups.forEach(g => g.members.forEach(m => groupOf.set(m, g.id)));
  room.results = {
    failedLink: false,
    reason: room.endReason || 'all',
    teamPoints: team,
    points,
    cells,
    targets: room.players
      .filter(p => p.pick !== null)
      .map(p => ({
        id: p.id,
        name: p.name,
        clue: p.clue,
        assigned: p.assigned,
        pick: p.pick,
        group: groupOf.has(p.id) ? groupOf.get(p.id) : null
      })),
    groups: room.groups.map(g => ({
      id: g.id,
      pair: g.pair,
      members: g.members,
      same: g.same,
      yes: g.yes,
      no: g.no
    }))
  };
  room.phase = 'results';
}

/* ---------- views sent to each phone (never leaks hidden info) ---------- */

function doneFlag(room, p) {
  if (room.phase === 'link') return p.pick !== null;
  if (room.phase === 'think') return p.locked;
  if (room.phase === 'vote') {
    return !room.groups.some(g => !g.members.includes(p.id) && g.votes[p.id] === undefined);
  }
  return false;
}

function scoreboard(room) {
  const n = room.players.length;
  const byPlayer = {};
  let team = 0;
  room.players.forEach(p => {
    const total = p.roundPoints.reduce((a, b) => a + b, 0);
    byPlayer[p.id] = { rounds: p.roundPoints.slice(), total };
    team += total;
  });
  const perfect = n * (n - 1) * ROUNDS * 1.25;
  const pct = perfect > 0 ? Math.max(0, Math.floor((team / perfect) * 100)) : 0;
  return { byPlayer, team, perfect, pct, rating: rate(pct) };
}

function viewFor(room, me) {
  const v = {
    code: room.code,
    you: me.id,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    rounds: ROUNDS,
    wordset: room.wordset,
    wordsets: Object.entries(WORDSETS).map(([key, w]) => ({ key, name: w.name })),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    times: ROUND_SECONDS,
    endReason: room.endReason,
    players: room.players.map(p => ({ id: p.id, name: p.name, online: p.online, done: doneFlag(room, p) }))
  };
  if (room.phase === 'link' || room.phase === 'think') {
    v.timer = { total: room.totalMs, remainingMs: remaining(room), paused: room.paused };
    v.words = room.words;
    v.me = { assigned: me.assigned, pick: me.pick, clue: me.clue, guesses: me.guesses, locked: me.locked };
  }
  if (room.phase === 'think') {
    v.targets = room.players
      .filter(p => p.id !== me.id)
      .map(p => ({ id: p.id, name: p.name, clue: p.clue }));
  }
  if (room.phase === 'vote') {
    v.words = room.words;
    v.vote = {
      groups: room.groups.map(g => ({
        id: g.id,
        pair: g.pair,
        members: g.members.map(id => {
          const p = room.players.find(x => x.id === id);
          return { id, name: p.name, clue: p.clue };
        }),
        canVote: !g.members.includes(me.id),
        myVote: g.votes[me.id],
        voters: room.players.filter(p => !g.members.includes(p.id)).map(p => p.id),
        voted: Object.keys(g.votes)
      }))
    };
  }
  if (room.phase === 'results') {
    v.words = room.words;
    v.results = room.results;
  }
  if (room.round > 0) v.score = scoreboard(room);
  return v;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) if (p.online) send(p.ws, { t: 'state', state: viewFor(room, p) });
}
function fail(ws, msg) {
  send(ws, { t: 'error', msg });
}

/* ---------- connection handling ---------- */

function goOffline(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const { room, player } = ctx;
  if (player.ws === ws) {
    player.online = false;
    player.ws = null;
    if (room.hostId === player.id) {
      const next = room.players.find(x => x.online);
      if (next) room.hostId = next.id;
    }
    broadcast(room);
  }
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      const name = cleanName(msg.name);
      if (!name) return fail(ws, 'Enter your name first.');
      goOffline(ws);
      const room = newRoom();
      rooms.set(room.code, room);
      const p = addPlayer(room, name, ws);
      room.hostId = p.id;
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'join': {
      const name = cleanName(msg.name);
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!name) return fail(ws, 'Enter your name first.');
      if (!room) return fail(ws, 'No game with that code.');
      if (room.phase !== 'lobby') return fail(ws, 'That game has already started.');
      if (room.players.length >= MAX_PLAYERS) return fail(ws, 'That game is full (6 players).');
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        return fail(ws, 'Someone already has that name. Pick another.');
      }
      goOffline(ws);
      const p = addPlayer(room, name, ws);
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'rejoin': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      const p = room && room.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'gone' });
      goOffline(ws);
      if (p.ws && p.ws !== ws) {
        const old = p.ws;
        old.ctx = null;
        try {
          old.terminate();
        } catch (e) {}
      }
      p.ws = ws;
      p.online = true;
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'ping':
      return;
  }

  const ctx = ws.ctx;
  if (!ctx) return fail(ws, 'You are not in a game.');
  const { room, player: me } = ctx;
  const isHost = room.hostId === me.id;
  const timed = room.phase === 'link' || room.phase === 'think';
  const words = room.words;

  switch (msg.t) {
    case 'leave': {
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== me.id);
        ws.ctx = null;
        if (!room.players.length) rooms.delete(room.code);
        else {
          if (room.hostId === me.id) room.hostId = (room.players.find(p => p.online) || room.players[0]).id;
          broadcast(room);
        }
      } else goOffline(ws);
      return;
    }
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const target = room.players.find(p => p.id === msg.id);
      if (!target || target.id === me.id) return;
      room.players = room.players.filter(p => p.id !== target.id);
      if (target.ws) {
        send(target.ws, { t: 'gone' });
        target.ws.ctx = null;
      }
      return broadcast(room);
    }
    case 'setWordset': {
      if (!isHost || room.phase !== 'lobby' || !WORDSETS[msg.wordset]) return;
      room.wordset = msg.wordset;
      return broadcast(room);
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      const n = room.players.length;
      if (n < MIN_PLAYERS || n > MAX_PLAYERS) return fail(ws, 'Thinkage needs 3 to 6 players.');
      const off = room.players.find(p => !p.online);
      if (off) return fail(ws, off.name + ' is offline. Wait for them to return or remove them.');
      startGame(room);
      return broadcast(room);
    }
    case 'pause': {
      if (!isHost || !timed || room.paused) return;
      room.remainingMs = remaining(room);
      room.paused = true;
      return broadcast(room);
    }
    case 'resume': {
      if (!isHost || !timed || !room.paused) return;
      room.endAt = Date.now() + room.remainingMs;
      room.paused = false;
      return broadcast(room);
    }
    case 'pick': {
      if (room.phase !== 'link' || room.paused) return;
      const pick = msg.pick;
      if (!Number.isInteger(pick) || pick < 0 || pick >= words.length || pick === me.assigned) {
        return fail(ws, 'Pick a word from the list other than your own.');
      }
      const clue = String(msg.clue || '').trim();
      if (!clue) return fail(ws, 'Type your one-word clue.');
      if (/\s/.test(clue)) return fail(ws, 'The clue must be one word.');
      if (clue.length > 30) return fail(ws, 'That clue is too long.');
      me.pick = pick;
      me.clue = clue;
      if (room.players.every(p => p.pick !== null)) {
        room.endReason = 'all';
        startThink(room);
      }
      return broadcast(room);
    }
    case 'withdraw': {
      if (room.phase !== 'link') return;
      me.pick = null;
      me.clue = null;
      return broadcast(room);
    }
    case 'guess': {
      if (room.phase !== 'think' || room.paused || me.locked) return;
      const target = room.players.find(p => p.id === msg.target);
      const { a, b } = msg;
      if (!target || target.id === me.id) return;
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return;
      if (a < 0 || b < 0 || a >= words.length || b >= words.length) return;
      me.guesses[target.id] = { a, b, star: !!msg.star };
      return broadcast(room);
    }
    case 'clear': {
      if (room.phase !== 'think' || room.paused || me.locked) return;
      delete me.guesses[msg.target];
      return broadcast(room);
    }
    case 'lock': {
      if (room.phase !== 'think' || room.paused) return;
      const others = room.players.filter(p => p.id !== me.id);
      if (!others.every(p => me.guesses[p.id])) return fail(ws, 'Make a guess for every player first.');
      me.locked = true;
      if (room.players.every(p => p.locked)) {
        room.endReason = 'all';
        endThink(room);
      }
      return broadcast(room);
    }
    case 'unlock': {
      if (room.phase !== 'think') return;
      me.locked = false;
      return broadcast(room);
    }
    case 'vote': {
      if (room.phase !== 'vote') return;
      const g = room.groups[msg.group];
      if (!g || g.members.includes(me.id)) return;
      g.votes[me.id] = !!msg.same;
      if (votesComplete(room)) finishRound(room);
      return broadcast(room);
    }
    case 'skipVotes': {
      if (!isHost || room.phase !== 'vote') return;
      finishRound(room);
      return broadcast(room);
    }
    case 'next': {
      if (!isHost || room.phase !== 'results') return;
      if (room.round < ROUNDS) startRound(room);
      else room.phase = 'over';
      return broadcast(room);
    }
    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      room.phase = 'lobby';
      room.round = 0;
      room.words = [];
      room.results = null;
      room.groups = [];
      room.players.forEach(p => {
        p.roundPoints = [];
        resetPlayerRound(p);
      });
      // Drop anyone who left during the game so the next lobby starts clean.
      room.players = room.players.filter(p => p.online);
      if (!room.players.some(p => p.id === room.hostId)) room.hostId = room.players[0].id;
      return broadcast(room);
    }
  }
}

/* ---------- servers ---------- */

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error(e);
      fail(ws, 'Something went wrong.');
    }
  });
  ws.on('close', () => goOffline(ws));
  ws.on('error', () => {});
});

// Keep connections alive through Render's proxy and drop dead sockets.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, 25000);

// Round clock, plus clean-up of abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if ((room.phase === 'link' || room.phase === 'think') && !room.paused && now >= room.endAt) {
      room.endReason = 'time';
      if (room.phase === 'link') failLink(room);
      else endThink(room);
      broadcast(room);
    }
    const idle = now - room.lastActive;
    const nobody = room.players.every(p => !p.online);
    if (idle > 6 * 3600 * 1000 || (nobody && idle > 30 * 60 * 1000)) rooms.delete(room.code);
  }
}, 250);

server.listen(PORT, '0.0.0.0', () => console.log('Thinkage listening on port ' + PORT));

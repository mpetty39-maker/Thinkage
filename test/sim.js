'use strict';
// Plays whole games with simulated phones against a real server and checks the scoring.
// Run with: npm test
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 4100 + Math.floor(Math.random() * 500);
const URL = 'ws://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Phone {
  constructor(name) {
    this.name = name;
    this.S = null;
    this.errors = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'state') this.S = m.state;
        if (m.t === 'joined') { this.code = m.code; this.token = m.token; }
        if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async waitFor(pred, label, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.S && pred(this.S)) return this.S;
      await sleep(15);
    }
    throw new Error('Timed out waiting for: ' + label + ' (phase ' + (this.S && this.S.phase) + ')');
  }
}

async function lobby(n, wordset) {
  const phones = [];
  for (let i = 0; i < n; i++) {
    const p = new Phone('P' + (i + 1));
    await p.open();
    phones.push(p);
  }
  phones[0].send({ t: 'create', name: 'P1' });
  await phones[0].waitFor(s => s.phase === 'lobby', 'lobby');
  for (let i = 1; i < n; i++) {
    phones[i].send({ t: 'join', code: phones[0].code, name: 'P' + (i + 1) });
    await phones[i].waitFor(s => s.phase === 'lobby', 'join');
  }
  if (wordset) phones[0].send({ t: 'setWordset', wordset });
  return phones;
}

async function startRound(phones, first) {
  if (first) phones[0].send({ t: 'start' });
  else phones[0].send({ t: 'next' });
  for (const p of phones) await p.waitFor(s => s.phase === 'link' && s.me, 'link phase');
}

// picks[i] = word index player i links to their assigned word (or null to skip), clues[i] = clue
function link(phones, picks, clues) {
  phones.forEach((p, i) => {
    if (picks[i] !== null) p.send({ t: 'pick', pick: picks[i], clue: clues[i] });
  });
}
const plusOne = phones => phones.map(p => (p.S.me.assigned + 1) % p.S.words.length);

// Everyone's true pair, gathered from each phone's own knowledge.
function truth(phones, picks) {
  const t = {};
  phones.forEach((p, i) => (t[p.S.you] = [p.S.me.assigned, picks[i]]));
  return t;
}
function guessAll(phones, t, opts = {}) {
  phones.forEach((p, i) => {
    p.S.targets.forEach(tg => {
      let [a, b] = t[tg.id];
      const o = (opts[i] && opts[i][tg.id]) || {};
      if (o.wrong) {
        const n = p.S.words.length;
        a = (a + 2) % n === b ? (a + 3) % n : (a + 2) % n;
      }
      p.send({ t: 'guess', target: tg.id, a, b, star: !!o.star });
    });
  });
}
async function lockAll(phones) {
  await sleep(80);
  phones.forEach(p => p.send({ t: 'lock' }));
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TIME_SCALE: '0.1' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('listening') && r()));
  try {
    /* ---- Game 1: four players, wordset check, plain scoring, duplicate pair, link timeout ---- */
    let ph = await lobby(4, 'bible');
    await startRound(ph, true);
    assert.strictEqual(ph[0].S.words.length, 10, '4 players see 10 words');
    assert.ok(ph[0].S.timer.total === 14000, 'clock for 4 players is 2:20 scaled');
    // Hidden info check: nobody learns anyone else's word or pick before reveal.
    assert.ok(ph[0].S.players.every(p => !('assigned' in p) && !('pick' in p)), 'no leak of others words');
    // A player cannot pick their own word.
    ph[0].send({ t: 'pick', pick: ph[0].S.me.assigned, clue: 'x' });
    await sleep(80);
    assert.ok(ph[0].errors.length > 0, 'own word rejected');
    // Two-word clue is rejected.
    ph[0].errors = [];
    ph[0].send({ t: 'pick', pick: (ph[0].S.me.assigned + 1) % 10, clue: 'two words' });
    await sleep(80);
    assert.ok(ph[0].errors.length > 0, 'multi-word clue rejected');

    // Round 1: everyone correct; P1 stars a wrong guess on P2; P2 stars a right guess.
    let picks = plusOne(ph);
    link(ph, picks, ['alpha', 'bravo', 'charlie', 'delta']);
    for (const p of ph) await p.waitFor(s => s.phase === 'think', 'think');
    assert.ok(ph[0].S.targets.every(t => t.clue), 'clues visible in think');
    let t1 = truth(ph, picks);
    const p2id = ph[1].S.you, p1id = ph[0].S.you;
    guessAll(ph, t1, { 0: { [p2id]: { wrong: true, star: true } }, 1: { [ph[2].S.you]: { star: true } } });
    await lockAll(ph);
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results 1');
    let R = ph[0].S.results;
    assert.strictEqual(R.points[p1id], 1, 'P1: +1 +1 -1');
    assert.strictEqual(R.points[p2id], 4, 'P2: 2+1+1');
    assert.strictEqual(R.points[ph[2].S.you], 3);
    assert.strictEqual(R.points[ph[3].S.you], 3);
    assert.strictEqual(R.teamPoints, 11);

    // Round 2: P1 and P2 link the same pair with similar clues; P3 and P4 vote "same".
    await startRound(ph, false);
    const a1 = ph[0].S.me.assigned, a2 = ph[1].S.me.assigned;
    picks = [a2, a1, (ph[2].S.me.assigned + 1) % 10, (ph[3].S.me.assigned + 1) % 10];
    link(ph, picks, ['car', 'cars', 'echo', 'foxtrot']);
    for (const p of ph) await p.waitFor(s => s.phase === 'think', 'think 2');
    guessAll(ph, truth(ph, picks));
    await lockAll(ph);
    for (const p of ph) await p.waitFor(s => s.phase === 'vote', 'vote');
    ph[0].send({ t: 'vote', group: 0, same: true }); // a member cannot vote
    await sleep(80);
    assert.strictEqual(Object.keys(ph[2].S.vote.groups[0].voted).length, 0, 'member vote ignored');
    ph[2].send({ t: 'vote', group: 0, same: true });
    ph[3].send({ t: 'vote', group: 0, same: true });
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results 2');
    R = ph[0].S.results;
    assert.strictEqual(R.groups[0].same, true);
    assert.strictEqual(R.points[p1id], 2, 'P1 round 2');
    assert.strictEqual(R.points[p2id], 2);
    assert.strictEqual(R.points[ph[2].S.you], 1);
    assert.strictEqual(R.points[ph[3].S.you], 1);
    assert.strictEqual(R.teamPoints, 6);

    // Round 3: P4 never links, so the clock runs out and there is no Think phase.
    await startRound(ph, false);
    picks = plusOne(ph);
    link(ph, [picks[0], picks[1], picks[2], null], ['a', 'b', 'c', 'd']);
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'link timeout', 20000);
    R = ph[0].S.results;
    assert.strictEqual(R.failedLink, true);
    assert.strictEqual(R.teamPoints, 0);

    ph[0].send({ t: 'next' });
    for (const p of ph) await p.waitFor(s => s.phase === 'over', 'over');
    const sc = ph[0].S.score;
    assert.strictEqual(sc.team, 17);
    assert.strictEqual(sc.perfect, 45); // 4 * 3 * 3 rounds * 1.25
    assert.strictEqual(sc.pct, 37);
    assert.strictEqual(sc.rating, 'Not good! Better luck next time.');

    // Word lists never repeat inside one game.
    // (Checked implicitly through the pool slicing; verify rounds saw different words via a second game below.)

    ph[0].send({ t: 'again' });
    for (const p of ph) await p.waitFor(s => s.phase === 'lobby', 'back to lobby');
    ph.forEach(p => p.ws.close());

    /* ---- Game 2: three players, same pair but different clues, tie vote, star carries ---- */
    ph = await lobby(3);
    await startRound(ph, true);
    assert.strictEqual(ph[0].S.timer.total === 12000, true, 'clock for 3 players is 2:00 scaled');
    const seen = new Set(ph[0].S.words);
    const b1 = ph[0].S.me.assigned, b2 = ph[1].S.me.assigned;
    picks = [b2, b1, (ph[2].S.me.assigned + 1) % 10];
    link(ph, picks, ['dog', 'cat', 'golf']);
    for (const p of ph) await p.waitFor(s => s.phase === 'think', 'think g2');
    const t2 = truth(ph, picks);
    // P3 guesses both duplicate targets right, one starred: counts once, as 2 points.
    guessAll(ph, t2, { 2: { [ph[0].S.you]: { star: true } } });
    await lockAll(ph);
    for (const p of ph) await p.waitFor(s => s.phase === 'vote', 'vote g2');
    ph[2].send({ t: 'vote', group: 0, same: false });
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results g2');
    R = ph[0].S.results;
    assert.strictEqual(R.groups[0].same, false);
    assert.strictEqual(R.points[ph[0].S.you], 2, 'P1: P2 pair +1, P3 +1');
    assert.strictEqual(R.points[ph[1].S.you], 2);
    assert.strictEqual(R.points[ph[2].S.you], 2, 'P3: starred correct, counted once = 2');
    const cell = R.cells[ph[1].S.you][ph[2].S.you];
    assert.ok(cell.note === 'once' && cell.pts === 0, 'non-carrier cell marked once');

    // Round 2 words differ from round 1 words.
    await startRound(ph, false);
    ph[0].S.words.forEach(w => assert.ok(!seen.has(w), 'word repeated across rounds: ' + w));

    // Reconnect: a phone drops and rejoins with its token and gets its own secret word back.
    const old = ph[1];
    const mySecret = old.S.me.assigned;
    old.ws.close();
    await sleep(120);
    const back = new Phone('P2b');
    await back.open();
    back.send({ t: 'rejoin', code: old.code, token: old.token });
    await back.waitFor(s => s.phase === 'link' && s.me, 'rejoin');
    assert.strictEqual(back.S.me.assigned, mySecret, 'rejoin restores secret word');
    assert.strictEqual(back.S.players.filter(p => p.online).length, 3, 'all three online after rejoin');
    back.ws.close();

    console.log('All simulated games passed.');
  } finally {
    srv.kill();
  }
  process.exit(0);
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});

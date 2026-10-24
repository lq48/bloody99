'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, CODE_CHARS } = require('../src/rooms');
const { mulberry32 } = require('../src/cards');

// ---------- 測試工具：假時鐘 + 收件匣 ----------

function makeClock() {
  let t = 1_000_000;
  let seq = 0;
  let list = [];
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; list.push({ id, at: t + ms, fn }); return id; },
      clearTimeout: (id) => { list = list.filter((x) => x.id !== id); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at);
        const next = list[0];
        if (!next || next.at > end) break;
        list.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function setup(seed = 11) {
  const clock = makeClock();
  const inbox = {}; // socketId → 最新的 state
  const other = []; // 其他事件
  const mgr = new RoomManager({
    send: (sid, ev, payload) => { if (ev === 'state') inbox[sid] = payload; else other.push({ sid, ev, payload }); },
    timers: clock.timers,
    now: clock.now,
    rng: mulberry32(seed),
  });
  return { mgr, clock, inbox, other };
}

// 開一個房間並讓 n 個人加入，回傳每個人的 socketId 與 token
function roomWith(env, n) {
  const { mgr } = env;
  const people = [];
  const r = mgr.createRoom('s0', { name: '房主' });
  people.push({ sid: 's0', token: r.token, id: r.memberId });
  for (let i = 1; i < n; i++) {
    const j = mgr.joinRoom('s' + i, { name: '玩家' + i, code: r.code.toLowerCase() });
    people.push({ sid: 's' + i, token: j.token, id: j.memberId });
  }
  return { code: r.code, people };
}

// ---------- 開房與加入 ----------

test('開房：4 碼房號只用英文字母和數字，開房者是房主', () => {
  const env = setup();
  const { code } = roomWith(env, 1);
  assert.equal(code.length, 4);
  for (const ch of code) assert.ok(CODE_CHARS.includes(ch));
  assert.equal(env.inbox.s0.you.isHost, true);
  assert.equal(env.inbox.s0.status, 'lobby');
});

test('加入：房號不分大小寫；暱稱重複或房號錯誤會被拒絕', () => {
  const env = setup();
  const { code } = roomWith(env, 2);
  assert.equal(env.inbox.s1.members.length, 2);
  assert.throws(() => env.mgr.joinRoom('x', { name: '玩家1', code }), { code: 'NAME_TAKEN' });
  assert.throws(() => env.mgr.joinRoom('x', { name: '新人', code: 'ZZZZ' }), { code: 'ROOM_NOT_FOUND' });
  assert.throws(() => env.mgr.joinRoom('x', { name: '', code }), { code: 'BAD_NAME' });
  assert.throws(() => env.mgr.joinRoom('x', { name: '一二三四五六七八九十一二三', code }), { code: 'BAD_NAME' });
});

test('大廳最多 10 位玩家，第 11 位起變成觀戰者', () => {
  const env = setup();
  const { code } = roomWith(env, 10);
  const r = env.mgr.joinRoom('s10', { name: '第十一位', code });
  assert.equal(r.role, 'spectator');
});

// ---------- 開始遊戲 ----------

test('只有房主能開始；少於 2 人不能開始', () => {
  const env = setup();
  roomWith(env, 1);
  assert.throws(() => env.mgr.startGame('s0'), { code: 'PLAYER_COUNT' });
  env.mgr.joinRoom('s1', { name: 'B', code: env.inbox.s0.code });
  assert.throws(() => env.mgr.startGame('s1'), { code: 'NOT_HOST' });
  env.mgr.startGame('s0');
  assert.equal(env.inbox.s1.status, 'playing');
});

test('遊戲中每個人只拿到自己的手牌', () => {
  const env = setup();
  roomWith(env, 3);
  env.mgr.startGame('s0');
  const s = env.inbox.s1;
  assert.equal(s.game.you.hand.length, 5);
  assert.ok(s.game.players.every((p) => p.handCount === 5 && !('hand' in p)));
  const mine = new Set(s.game.you.hand.map((c) => c.id));
  for (const c of env.inbox.s2.game.you.hand) assert.ok(!mine.has(c.id));
});

test('遊戲進行中才進房的人只能觀戰，看不到任何手牌', () => {
  const env = setup();
  const { code } = roomWith(env, 2);
  env.mgr.startGame('s0');
  const r = env.mgr.joinRoom('s9', { name: '路人', code });
  assert.equal(r.role, 'spectator');
  assert.equal(env.inbox.s9.game.you, null);
  assert.throws(() => env.mgr.action('s9', { type: 'detonate' }), { code: 'NOT_PLAYER' });
});

test('陣營模式手動分隊：選隊後開局，隊伍全部公開', () => {
  const env = setup();
  roomWith(env, 4);
  env.mgr.setSettings('s0', { mode: 'team', teamAssignment: 'manual' });
  assert.throws(() => env.mgr.startGame('s0'), { code: 'NEED_TEAMS' });
  ['red', 'red', 'black', 'black'].forEach((t, i) => env.mgr.pickTeam('s' + i, { team: t }));
  assert.equal(env.inbox.s3.members[0].team, 'red');
  env.mgr.startGame('s0');
  const teams = env.inbox.s3.game.players.map((p) => p.team);
  assert.deepEqual(teams, ['red', 'red', 'black', 'black']);
});

test('陣營模式隨機分隊：隊友身分不會外洩給其他人', () => {
  const env = setup(5);
  roomWith(env, 6);
  env.mgr.setSettings('s0', { mode: 'team', teamAssignment: 'random' });
  env.mgr.startGame('s0');
  const view = env.inbox.s0.game;
  const hidden = view.players.filter((p) => p.team === null);
  // 6 人中，自己和兩位國王看得到隊伍，其他人隱藏
  const meIsKing = view.players.find((p) => p.id === view.you.id).isKing;
  assert.equal(hidden.length, meIsKing ? 4 : 3);
});

// ---------- 斷線與重連 ----------

test('斷線：房主立刻交給下一位；90 秒內用 token 重連會回到原座位', () => {
  const env = setup();
  const { people } = roomWith(env, 3);
  env.mgr.startGame('s0');
  const handBefore = env.inbox.s0.game.you.hand.map((c) => c.id);
  env.mgr.disconnect('s0');
  assert.equal(env.inbox.s1.hostId, people[1].id);
  env.clock.advance(60_000);
  env.mgr.resume('s0b', { token: people[0].token });
  assert.deepEqual(env.inbox.s0b.game.you.hand.map((c) => c.id), handBefore);
  assert.equal(env.inbox.s0b.you.isHost, false, '房主已經交給別人，不會自動拿回');
  env.clock.advance(60_000);
  assert.equal(env.inbox.s1.members.length, 3, '重連後不會被踢');
});

test('斷線超過 90 秒：踢出房間，遊戲中視同出局', () => {
  const env = setup();
  const { people } = roomWith(env, 3);
  env.mgr.startGame('s0');
  env.mgr.disconnect('s2');
  env.clock.advance(89_000);
  assert.equal(env.inbox.s0.members.length, 3);
  env.clock.advance(2_000);
  assert.equal(env.inbox.s0.members.length, 2);
  const gp = env.inbox.s0.game.players.find((p) => p.id === people[2].id);
  assert.equal(gp.alive, false);
  assert.throws(() => env.mgr.resume('s2b', { token: people[2].token }), { code: 'SESSION_EXPIRED' });
});

test('輪到斷線的人時，全員等他；90 秒沒回來就換下一位', () => {
  const env = setup();
  const { people } = roomWith(env, 3);
  env.mgr.startGame('s0');
  const g = env.mgr.rooms.get(env.inbox.s0.code).game;
  const cur = people.find((p) => p.id === g.currentId);
  env.mgr.disconnect(cur.sid);
  env.clock.advance(30_000);
  assert.equal(g.currentId, cur.id, '還在等他');
  env.clock.advance(61_000);
  assert.notEqual(g.currentId, cur.id);
});

test('同一個人從另一個分頁連進來，舊分頁會被通知', () => {
  const env = setup();
  const { people } = roomWith(env, 2);
  env.mgr.resume('s1-new', { token: people[1].token });
  assert.ok(env.other.some((o) => o.sid === 's1' && o.ev === 'replaced'));
  assert.throws(() => env.mgr.chat('s1', { text: 'hi' }), { code: 'NOT_IN_ROOM' });
});

test('所有人都離開後，房間會被刪除', () => {
  const env = setup();
  const { code } = roomWith(env, 2);
  env.mgr.leaveRoom('s0');
  env.mgr.disconnect('s1');
  env.clock.advance(91_000);
  assert.equal(env.mgr.rooms.has(code), false);
});

// ---------- 引爆倒數 ----------

test('無牌可出：10 秒沒按引爆就自動引爆', () => {
  const env = setup();
  const { people } = roomWith(env, 3);
  env.mgr.startGame('s0');
  const room = env.mgr.rooms.get(env.inbox.s0.code);
  const g = room.game;
  // 讓目前的玩家手上只有出不了的牌
  const cur = g.players[g.currentIndex];
  let n = 0;
  cur.hand = ['9', '8', '6'].map((rank) => ({ id: 'x' + n++, rank, suit: 'S' }));
  g.total = 99;
  const evs = [];
  g._checkTurnStart(evs);
  env.mgr._afterGame(room, evs);
  assert.equal(g.phase, 'awaitDetonate');
  assert.ok(env.inbox.s0.game.detonateDeadline);
  env.clock.advance(9_000);
  assert.equal(cur.alive, true);
  env.clock.advance(1_500);
  assert.equal(cur.alive, false);
  assert.ok(env.inbox.s0.log.some((e) => e.type === 'eliminated' && e.reason === 'noMove'));
  assert.ok(people.length === 3);
});

// ---------- 再來一局與聊天 ----------

test('一局結束後，房主帶大家回到大廳，觀戰者補上空位', () => {
  const env = setup();
  const { code } = roomWith(env, 2);
  env.mgr.startGame('s0');
  env.mgr.joinRoom('s5', { name: '觀戰者', code });
  const room = env.mgr.rooms.get(code);
  room.game.removePlayer(room.game.players[1].id);
  env.mgr._afterGame(room, []);
  assert.equal(env.inbox.s0.status, 'ended');
  assert.throws(() => env.mgr.backToLobby('s1'), { code: 'NOT_HOST' });
  env.mgr.backToLobby('s0');
  assert.equal(env.inbox.s5.status, 'lobby');
  assert.equal(env.inbox.s5.you.role, 'player');
});

test('聊天：全員看得到；空白、太長、太快都會被擋', () => {
  const env = setup();
  roomWith(env, 2);
  env.mgr.chat('s1', { text: '大家好' });
  assert.equal(env.inbox.s0.chat.at(-1).text, '大家好');
  assert.throws(() => env.mgr.chat('s1', { text: '   ' }), { code: 'EMPTY_CHAT' });
  assert.throws(() => env.mgr.chat('s1', { text: 'a'.repeat(201) }), { code: 'CHAT_TOO_LONG' });
  for (let i = 0; i < 4; i++) env.mgr.chat('s1', { text: 'x' + i });
  assert.throws(() => env.mgr.chat('s1', { text: '太快' }), { code: 'CHAT_TOO_FAST' });
  env.clock.advance(6_000);
  assert.doesNotThrow(() => env.mgr.chat('s1', { text: '好了' }));
});

// ---------- 整局模擬：玩家只靠自己畫面上的資訊來玩 ----------

function botMove(env, sid, rng) {
  const s = env.inbox[sid];
  const g = s.game;
  if (g.phase === 'awaitDetonate' && g.currentId === s.you.id) {
    env.mgr.action(sid, { type: 'detonate' });
    return true;
  }
  if (g.phase === 'awaitJokerKeep' && g.pending.targetId === s.you.id) {
    env.mgr.action(sid, { type: 'jokerKeep', cardId: g.you.hand[0].id });
    return true;
  }
  if (g.phase !== 'playing' || g.currentId !== s.you.id) return false;
  const hand = g.you.hand;
  const others = g.players.filter((p) => p.alive && p.id !== s.you.id);
  const tries = [];
  for (const a of hand) tries.push([a.id]);
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      tries.push([hand[i].id, hand[j].id]);
      for (let k = j + 1; k < hand.length; k++) tries.push([hand[i].id, hand[j].id, hand[k].id]);
    }
  }
  tries.sort(() => rng() - 0.5);
  for (const cardIds of tries) {
    for (const choice of ['-', '+']) {
      const targetId = others[Math.floor(rng() * others.length)].id;
      try {
        env.mgr.action(sid, { type: 'play', cardIds, choice, targetId });
        return true;
      } catch (e) {
        if (!e.code) throw e;
      }
    }
  }
  throw new Error('找不到出法');
}

test('模擬 60 整局：每位玩家只用自己畫面上的資訊，都能玩到結束', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const env = setup(seed);
    const n = 2 + (seed % 9);
    const { people } = roomWith(env, n);
    if (n >= 4 && seed % 2 === 0) env.mgr.setSettings('s0', { mode: 'team' });
    env.mgr.startGame('s0');
    const rng = mulberry32(seed * 7);
    let steps = 0;
    while (env.inbox.s0.status === 'playing') {
      assert.ok(steps++ < 3000, 'seed ' + seed + ' 沒有結束');
      const moved = people.some((p) => botMove(env, p.sid, rng));
      assert.ok(moved, 'seed ' + seed + ' 沒有人能動');
    }
    assert.equal(env.inbox.s0.status, 'ended');
    assert.ok(env.inbox.s0.game.winner);
  }
});

// ---------- 真實連線測試 ----------

test('真實連線：兩個瀏覽器透過網路開房、加入、開始遊戲', async () => {
  const { startServer } = require('../src/server');
  const { io: connect } = require('socket.io-client');
  const srv = await startServer({ port: 0 });
  const url = 'http://localhost:' + srv.port;
  const a = connect(url, { transports: ['websocket'] });
  const b = connect(url, { transports: ['websocket'] });
  const call = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
  const nextState = (sock, pred) => new Promise((res) => {
    const h = (s) => { if (pred(s)) { sock.off('state', h); res(s); } };
    sock.on('state', h);
  });
  try {
    const created = await call(a, 'createRoom', { name: '阿凱' });
    assert.equal(created.ok, true);
    const bad = await call(b, 'joinRoom', { name: '小雨', code: 'QQQQ' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'ROOM_NOT_FOUND');
    const joined = await call(b, 'joinRoom', { name: '小雨', code: created.code });
    assert.equal(joined.ok, true);
    const playing = nextState(b, (s) => s.status === 'playing');
    const started = await call(a, 'startGame', {});
    assert.equal(started.ok, true);
    const s = await playing;
    assert.equal(s.game.you.hand.length, 5);
    assert.equal(s.game.total, 99);
    const res = await fetch(url + '/healthz');
    assert.equal(await res.text(), 'ok');
  } finally {
    a.close();
    b.close();
    await srv.close();
  }
});

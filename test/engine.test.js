'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, redactEvent } = require('../src/engine');
const { createDeck, mulberry32 } = require('../src/cards');

// ---------- 測試工具 ----------

let cid = 0;
const C = (rank) => ({ id: 't' + cid++, rank, suit: rank === 'JOKER' ? null : 'S' });

function newGame(n = 3, opts = {}) {
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '玩家' + i }));
  return new Game({ players, rng: mulberry32(opts.seed ?? 7), ...opts });
}

// 把牌局設定成指定的情境
function rig(g, { hands, current = 0, total = 99, direction = 1 }) {
  hands.forEach((ranks, i) => { g.players[i].hand = ranks.map(C); });
  g.currentIndex = current;
  g.total = total;
  g.direction = direction;
  g.phase = 'playing';
  g.pending = null;
  g._checkTurnStart([]);
}

// 依點數從某位玩家手上挑出牌的 id
function pick(g, pid, ...ranks) {
  const used = new Set();
  return ranks.map((r) => {
    const c = g.getPlayer(pid).hand.find((x) => x.rank === r && !used.has(x.id));
    assert.ok(c, '手上沒有 ' + r);
    used.add(c.id);
    return c.id;
  });
}

const handOf = (g, pid) => g.getPlayer(pid).hand.map((c) => c.rank);
const types = (events) => events.map((e) => e.type);

// ---------- 牌組與開局 ----------

test('牌組：兩副牌加兩張鬼牌，共 106 張', () => {
  const deck = createDeck();
  assert.equal(deck.length, 106);
  assert.equal(deck.filter((c) => c.rank === 'JOKER').length, 2);
  assert.equal(new Set(deck.map((c) => c.id)).size, 106);
});

test('開局：每人 5 張、總數 99、順時針', () => {
  const g = newGame(4);
  for (const p of g.players) assert.equal(p.hand.length, 5);
  assert.equal(g.total, 99);
  assert.equal(g.direction, 1);
  assert.equal(g.deck.length, 106 - 20);
});

test('人數限制：少於 2 人或超過 10 人不能開局，陣營模式至少 4 人', () => {
  assert.throws(() => newGame(1), { code: 'PLAYER_COUNT' });
  assert.throws(() => newGame(11), { code: 'PLAYER_COUNT' });
  assert.throws(() => newGame(3, { mode: 'team' }), { code: 'PLAYER_COUNT' });
  assert.doesNotThrow(() => newGame(4, { mode: 'team' }));
});

// ---------- 總數規則 ----------

test('總數 99 時普通數字牌不能出', () => {
  const g = newGame(3);
  rig(g, { hands: [['9', 'J'], ['2'], ['2']] });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '9') }), { code: 'OVER_99' });
});

test('數字牌加到總數，剛好 99 合法', () => {
  const g = newGame(3);
  rig(g, { hands: [['9', 'J'], ['2'], ['2']], total: 90 });
  g.play('p0', { cardIds: pick(g, 'p0', '9') });
  assert.equal(g.total, 99);
});

test('10 減到負數時歸零，而且可以這樣出', () => {
  const g = newGame(3);
  rig(g, { hands: [['10', 'J'], ['2'], ['2']], total: 5 });
  g.play('p0', { cardIds: pick(g, 'p0', '10'), choice: '-' });
  assert.equal(g.total, 0);
});

test('Q 加 20 不能超過 99；10、Q 一定要選加或減', () => {
  const g = newGame(3);
  rig(g, { hands: [['Q', 'J'], ['2'], ['2']], total: 80 });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', 'Q'), choice: '+' }), { code: 'OVER_99' });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', 'Q') }), { code: 'NEED_CHOICE' });
  g.play('p0', { cardIds: pick(g, 'p0', 'Q'), choice: '-' });
  assert.equal(g.total, 60);
});

test('K 讓總數變成 99；J 總數不變', () => {
  const g = newGame(3);
  rig(g, { hands: [['K', '2'], ['J', '2'], ['2']], total: 40 });
  g.play('p0', { cardIds: pick(g, 'p0', 'K') });
  assert.equal(g.total, 99);
  g.play('p1', { cardIds: pick(g, 'p1', 'J') });
  assert.equal(g.total, 99);
});

// ---------- 抽牌 ----------

test('出一次牌抽一張；組合出多張也只抽一張', () => {
  const g = newGame(3);
  rig(g, { hands: [['4', '9', '2', '2'], ['J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '4', '9') }); // 組合成 K
  assert.equal(g.getPlayer('p0').hand.length, 3); // 4 - 2 + 1
});

test('使用 A 或 7 不抽牌', () => {
  const g = newGame(3);
  rig(g, { hands: [['7', '2'], ['J', 'J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '7'), targetId: 'p1' });
  assert.equal(g.getPlayer('p0').hand.length, 2); // 出 7、偷 1、不抽

  const g2 = newGame(3);
  rig(g2, { hands: [['A', '2'], ['J', 'J', 'J'], ['J']] });
  g2.play('p0', { cardIds: pick(g2, 'p0', 'A'), targetId: 'p1' });
  assert.equal(g2.getPlayer('p0').hand.length, 3); // 換到對方的 3 張，不抽
});

test('牌堆抽完時，把棄牌洗回去', () => {
  const g = newGame(3);
  rig(g, { hands: [['J', '2'], ['J'], ['J']] });
  g.discard = g.deck.splice(0);
  g.play('p0', { cardIds: pick(g, 'p0', 'J') });
  assert.equal(g.getPlayer('p0').hand.length, 2);
  assert.ok(g.deck.length > 0);
});

// ---------- 組合出牌 ----------

test('組合 4+9 當 K，總數變 99', () => {
  const g = newGame(3);
  rig(g, { hands: [['4', '9', '2'], ['J'], ['J']], total: 50 });
  const ev = g.play('p0', { cardIds: pick(g, 'p0', '4', '9') });
  assert.equal(g.total, 99);
  assert.equal(ev[0].as, 'K');
  assert.equal(ev[0].combo, true);
  assert.equal(g.direction, 1, '組合中的 4 不會發動迴轉');
});

test('組合 2+2+3 當 7：抽別人一張，不抽牌堆', () => {
  const g = newGame(3);
  rig(g, { hands: [['2', '2', '3', 'J'], ['J', 'J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '2', '2', '3'), targetId: 'p1' });
  assert.deepEqual(handOf(g, 'p0').sort(), ['J', 'J']);
  assert.equal(g.getPlayer('p1').hand.length, 1);
});

test('組合 2+4 當 6，總數加 6', () => {
  const g = newGame(3);
  rig(g, { hands: [['2', '4', 'J'], ['J'], ['J']], total: 80 });
  g.play('p0', { cardIds: pick(g, 'p0', '2', '4') });
  assert.equal(g.total, 86);
});

test('組合超過 13 不合法；鬼牌不能組合', () => {
  const g = newGame(3);
  rig(g, { hands: [['9', '8', 'JOKER', '2'], ['J'], ['J']] });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '9', '8') }), { code: 'COMBO_RANGE' });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', 'JOKER', '2') }), { code: 'COMBO_JOKER' });
});

test('組合時 J=11、Q=12、K=13、A=1', () => {
  const g = newGame(3);
  rig(g, { hands: [['A', 'J', '2'], ['J'], ['J']], total: 30 });
  const ev = g.play('p0', { cardIds: pick(g, 'p0', 'A', 'J'), choice: '-' }); // 1+11=12 → Q
  assert.equal(ev[0].as, 'Q');
  assert.equal(g.total, 10);
});

// ---------- 功能牌 ----------

test('4 迴轉：方向反轉，下一位變成反方向的人', () => {
  const g = newGame(4);
  rig(g, { hands: [['4', '2'], ['J'], ['J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '4') });
  assert.equal(g.direction, -1);
  assert.equal(g.currentId, 'p3');
});

test('只剩兩人時，4 等同換對方出', () => {
  const g = newGame(2);
  rig(g, { hands: [['4', '2'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '4') });
  assert.equal(g.currentId, 'p1');
});

test('5 指定：被指定者出牌，之後照原方向往下', () => {
  const g = newGame(5);
  rig(g, { hands: [['5', '2'], ['J'], ['J'], ['J', 'J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', '5'), targetId: 'p3' });
  assert.equal(g.currentId, 'p3');
  g.play('p3', { cardIds: pick(g, 'p3', 'J') });
  assert.equal(g.currentId, 'p4');
});

test('指定類的牌不能指定自己或已出局的人', () => {
  const g = newGame(4);
  rig(g, { hands: [['5', '2'], ['J'], ['J'], ['J']] });
  g.players[2].alive = false;
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '5'), targetId: 'p0' }), { code: 'TARGET_SELF' });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '5'), targetId: 'p2' }), { code: 'TARGET_DEAD' });
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '5') }), { code: 'NEED_TARGET' });
});

test('7 偷走對方最後一張牌，對方立刻出局', () => {
  const g = newGame(3);
  rig(g, { hands: [['7', '2'], ['J'], ['J']] });
  const ev = g.play('p0', { cardIds: pick(g, 'p0', '7'), targetId: 'p1' });
  assert.equal(g.getPlayer('p1').alive, false);
  assert.ok(types(ev).includes('eliminated'));
  assert.equal(g.currentId, 'p2', '出局者被跳過');
});

test('對方只剩一張 A 跟你換手牌，你立刻出局', () => {
  const g = newGame(3);
  rig(g, { hands: [['A'], ['J', 'J', 'J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', 'A'), targetId: 'p1' });
  assert.equal(g.getPlayer('p1').alive, false);
  assert.equal(g.getPlayer('p0').hand.length, 3);
});

test('鬼牌：被指定者自己選留哪張，其餘丟棄', () => {
  const g = newGame(3);
  rig(g, { hands: [['JOKER', '2'], ['J', 'K', '4'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', 'JOKER'), targetId: 'p1' });
  assert.equal(g.phase, 'awaitJokerKeep');
  assert.throws(() => g.chooseJokerKeep('p0', 'x'), { code: 'NOT_YOUR_CHOICE' });
  g.chooseJokerKeep('p1', pick(g, 'p1', 'K')[0]);
  assert.deepEqual(handOf(g, 'p1'), ['K']);
  assert.equal(g.phase, 'playing');
  assert.equal(g.currentId, 'p1');
});

test('鬼牌：對方只剩一張時，保留那張，不必等選擇', () => {
  const g = newGame(3);
  rig(g, { hands: [['JOKER', '2'], ['J'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', 'JOKER'), targetId: 'p1' });
  assert.equal(g.phase, 'playing');
  assert.deepEqual(handOf(g, 'p1'), ['J']);
});

// ---------- 出局 ----------

test('無牌可出：進入引爆階段，引爆後出局、手牌回收牌堆', () => {
  const g = newGame(3);
  const deckBefore = g.deck.length;
  rig(g, { hands: [['9', '8', '6'], ['J'], ['J']] });
  assert.equal(g.phase, 'awaitDetonate');
  assert.throws(() => g.play('p0', { cardIds: pick(g, 'p0', '9') }), { code: 'BAD_PHASE' });
  g.detonate('p0');
  assert.equal(g.getPlayer('p0').alive, false);
  assert.equal(g.deck.length, deckBefore + 3);
  assert.equal(g.currentId, 'p1');
});

test('有組合可出就不算無牌可出', () => {
  const g = newGame(3);
  rig(g, { hands: [['2', '3'], ['J'], ['J']] }); // 2+3 = 5
  assert.equal(g.phase, 'playing');
  rig(g, { hands: [['9', '9'], ['J'], ['J']] }); // 18 超過 13
  assert.equal(g.phase, 'awaitDetonate');
  rig(g, { hands: [['6'], ['J'], ['J']], total: 93 });
  assert.equal(g.phase, 'playing');
});

test('不能主動跳過：有合法出法時不能引爆', () => {
  const g = newGame(3);
  rig(g, { hands: [['J'], ['J'], ['J']] });
  assert.throws(() => g.detonate('p0'), { code: 'BAD_PHASE' });
});

test('個人模式：最後存活者獲勝', () => {
  const g = newGame(2);
  rig(g, { hands: [['7', '2'], ['J']] });
  const ev = g.play('p0', { cardIds: pick(g, 'p0', '7'), targetId: 'p1' });
  assert.equal(g.phase, 'ended');
  assert.deepEqual(g.winner, { type: 'player', playerId: 'p0' });
  assert.ok(types(ev).includes('gameOver'));
});

test('斷線被踢：視同出局，輪到他時換下一位', () => {
  const g = newGame(3);
  rig(g, { hands: [['J'], ['J'], ['J']] });
  g.removePlayer('p0');
  assert.equal(g.getPlayer('p0').alive, false);
  assert.equal(g.currentId, 'p1');
});

test('鬼牌等待中，被指定者斷線被踢：直接輪到下一位', () => {
  const g = newGame(4);
  rig(g, { hands: [['JOKER', '2'], ['J', 'K'], ['J', '2'], ['J']] });
  g.play('p0', { cardIds: pick(g, 'p0', 'JOKER'), targetId: 'p2' });
  assert.equal(g.phase, 'awaitJokerKeep');
  g.removePlayer('p2');
  assert.equal(g.phase, 'playing');
  assert.equal(g.currentId, 'p1');
});

// ---------- 陣營模式 ----------

test('陣營模式隨機分隊：兩隊各有一位國王，奇數人一隊多一人', () => {
  const g = newGame(5, { mode: 'team' });
  const red = g.players.filter((p) => p.team === 'red');
  const black = g.players.filter((p) => p.team === 'black');
  assert.equal(red.length + black.length, 5);
  assert.equal(Math.abs(red.length - black.length), 1);
  assert.equal(red.filter((p) => p.isKing).length, 1);
  assert.equal(black.filter((p) => p.isKing).length, 1);
});

test('陣營模式：擊倒對方國王就獲勝', () => {
  const g = newGame(4, { mode: 'team' });
  const blackKing = g.players.find((p) => p.isKing && p.team === 'black');
  const shooter = g.players.find((p) => p.id !== blackKing.id);
  const order = g.players.map((p) => p.id);
  const hands = order.map((id) => (id === shooter.id ? ['7', '2'] : id === blackKing.id ? ['J'] : ['J', 'J']));
  rig(g, { hands, current: order.indexOf(shooter.id) });
  g.play(shooter.id, { cardIds: pick(g, shooter.id, '7'), targetId: blackKing.id });
  assert.deepEqual(g.winner, { type: 'team', team: 'red' });
});

test('陣營模式：國王斷線被踢，該隊直接輸', () => {
  const g = newGame(4, { mode: 'team' });
  const redKing = g.players.find((p) => p.isKing && p.team === 'red');
  g.removePlayer(redKing.id);
  assert.deepEqual(g.winner, { type: 'team', team: 'black' });
});

test('陣營模式手動分隊：隊伍全部公開；有一隊沒人時不能開局', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id }));
  const g = new Game({
    players, mode: 'team', teamAssignment: 'manual', rng: mulberry32(3),
    manualTeams: { a: 'red', b: 'red', c: 'black', d: 'black' },
  });
  const view = g.getView('a');
  assert.deepEqual(view.players.map((p) => p.team), ['red', 'red', 'black', 'black']);
  assert.throws(() => new Game({
    players, mode: 'team', teamAssignment: 'manual', rng: mulberry32(3),
    manualTeams: { a: 'red', b: 'red', c: 'red', d: 'red' },
  }), { code: 'EMPTY_TEAM' });
});

// ---------- 資訊保密 ----------

test('玩家只看得到自己的手牌，別人只有張數', () => {
  const g = newGame(3);
  const view = g.getView('p1');
  assert.equal(view.you.hand.length, 5);
  assert.ok(view.players.every((p) => !('hand' in p)));
  assert.equal(view.players[0].handCount, 5);
  assert.equal(g.getView('spectator').you, null);
});

test('隨機分隊：只看得到自己、國王和已出局者的隊伍', () => {
  const g = newGame(6, { mode: 'team' });
  const me = g.players.find((p) => !p.isKing);
  const others = g.players.filter((p) => !p.isKing && p.id !== me.id);
  const view = g.getView(me.id);
  assert.equal(view.players.find((p) => p.id === me.id).team, me.team);
  for (const o of others) assert.equal(view.players.find((p) => p.id === o.id).team, null);
  for (const k of g.players.filter((p) => p.isKing)) {
    assert.equal(view.players.find((p) => p.id === k.id).team, k.team);
  }
  const victim = others[0];
  g._eliminate(victim, 'noMove', []);
  if (g.phase !== 'ended') {
    assert.equal(g.getView(me.id).players.find((p) => p.id === victim.id).team, victim.team);
  }
});

test('抽到或偷到的牌，只有當事人看得到', () => {
  const g = newGame(3);
  rig(g, { hands: [['7', '2'], ['J', 'J'], ['J']] });
  const ev = g.play('p0', { cardIds: pick(g, 'p0', '7'), targetId: 'p1' });
  const steal = ev.find((e) => e.type === 'steal');
  assert.ok(redactEvent(steal, 'p0').card);
  assert.ok(redactEvent(steal, 'p1').card);
  assert.equal(redactEvent(steal, 'p2').card, undefined);
});

// ---------- 整局模擬 ----------

test('隨機模擬 300 局：每局都能正常結束，牌的總數始終是 106 張', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(seed);
    const n = 2 + (seed % 9);
    const mode = n >= 4 && seed % 2 === 0 ? 'team' : 'solo';
    const g = newGame(n, { seed, mode });
    let guard = 0;
    while (g.phase !== 'ended') {
      assert.ok(guard++ < 5000, 'seed ' + seed + ' 沒有結束');
      if (g.phase === 'awaitDetonate') { g.detonate(g.currentId); continue; }
      if (g.phase === 'awaitJokerKeep') {
        const t = g.getPlayer(g.pending.targetId);
        g.chooseJokerKeep(t.id, t.hand[0].id);
        continue;
      }
      const me = g.getPlayer(g.currentId);
      const others = g.alivePlayers().filter((p) => p.id !== me.id);
      const target = others[Math.floor(rng() * others.length)].id;
      const choice = rng() < 0.5 ? '+' : '-';
      // 隨機試各種單張與兩張組合，直到找到合法的
      const tries = [];
      for (const c of me.hand) tries.push([c.id]);
      for (let i = 0; i < me.hand.length; i++) {
        for (let j = i + 1; j < me.hand.length; j++) tries.push([me.hand[i].id, me.hand[j].id]);
      }
      tries.sort(() => rng() - 0.5);
      let done = false;
      for (const cardIds of tries) {
        for (const ch of [choice, choice === '+' ? '-' : '+']) {
          try { g.play(me.id, { cardIds, choice: ch, targetId: target }); done = true; break; } catch (e) { if (!e.code) throw e; }
        }
        if (done) break;
      }
      // 有合法出法時一定找得到（三張以上的組合除外，這時改出單張 J 之類也會被找到）
      if (!done) {
        assert.ok(g.hasLegalMove(me.id), 'seed ' + seed + '：判定有牌可出卻找不到出法');
        // 只剩三張以上的組合可出，模擬時直接讓他引爆
        g.phase = 'awaitDetonate';
        g.detonate(me.id);
      }
      const count = g.deck.length + g.discard.length + g.players.reduce((s, p) => s + p.hand.length, 0);
      assert.equal(count, 106, 'seed ' + seed + ' 牌數不對');
      assert.ok(g.total >= 0 && g.total <= 99);
    }
  }
});

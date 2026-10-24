'use strict';

const {
  RANK_VALUE, NUMBER_RANKS, TARGET_RANKS, NO_DRAW_RANKS,
  createDeck, rankFromValue, shuffle,
} = require('./cards');

const MAX_TOTAL = 99;
const MIN_TOTAL = 0;

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 血腥99 規則引擎。
 * 所有牌局狀態都只存在這裡（伺服器端），玩家透過 getView() 只拿到自己該看到的資訊。
 *
 * 遊戲階段 phase：
 *   playing        輪到 currentId 出牌
 *   awaitDetonate  currentId 無牌可出，等他按引爆（伺服器負責 10 秒倒數後呼叫 detonate）
 *   awaitJokerKeep 有人被鬼牌指定，等被指定者選要留哪張
 *   ended          遊戲結束，winner 有值
 *
 * 每個動作都回傳 events 陣列，給畫面播放特效和寫行動紀錄用。
 */
class Game {
  constructor({
    players,
    mode = 'solo',
    teamAssignment = 'random',
    manualTeams = null,
    rng = Math.random,
    handSize = 5,
    deckOptions,
  }) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 10) {
      throw new GameError('PLAYER_COUNT', '玩家人數必須是 2～10 人');
    }
    if (mode !== 'solo' && mode !== 'team') {
      throw new GameError('BAD_MODE', '未知的遊戲模式');
    }
    if (mode === 'team' && players.length < 4) {
      throw new GameError('PLAYER_COUNT', '陣營模式至少要 4 人');
    }

    this.rng = rng;
    this.mode = mode;
    this.teamVisibility = mode === 'team' && teamAssignment === 'manual' ? 'public' : 'hidden';
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      hand: [],
      alive: true,
      team: null,
      isKing: false,
      eliminatedReason: null,
    }));

    if (mode === 'team') this._assignTeams(teamAssignment, manualTeams);

    this.deck = shuffle(createDeck(deckOptions), rng);
    this.discard = [];
    for (let i = 0; i < handSize; i++) {
      for (const p of this.players) this._drawOne(p);
    }

    this.total = MAX_TOTAL;
    this.direction = 1; // 1 = 順時針，-1 = 逆時針
    this.currentIndex = Math.floor(rng() * this.players.length);
    this.phase = 'playing';
    this.pending = null;
    this.winner = null;
    this.lastPlay = null;
    this.turn = 1;

    const events = [{ type: 'start', currentId: this.currentId, direction: this.direction, total: this.total }];
    this._checkTurnStart(events);
    this.startEvents = events;
  }

  // ---------- 對外的查詢 ----------

  get currentId() {
    return this.players[this.currentIndex].id;
  }

  getPlayer(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('NO_PLAYER', '找不到這位玩家');
    return p;
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  /** 這位玩家現在有沒有任何合法出法（單張或組合）。 */
  hasLegalMove(playerId) {
    const p = this.getPlayer(playerId);
    const othersAlive = this.alivePlayers().some((x) => x.id !== p.id);
    const values = [];

    for (const c of p.hand) {
      if (c.rank === 'JOKER') {
        if (othersAlive) return true;
        continue;
      }
      if (this._rankIsLegalSomehow(c.rank, RANK_VALUE[c.rank], othersAlive)) return true;
      values.push(RANK_VALUE[c.rank]);
    }

    // 組合：找出用兩張以上的牌可以湊出的點數（2～13）
    const one = new Array(14).fill(false);
    const many = new Array(14).fill(false);
    for (const v of values) {
      const nextMany = many.slice();
      for (let s = 1; s + v <= 13; s++) {
        if (one[s] || many[s]) nextMany[s + v] = true;
      }
      for (let s = 0; s < 14; s++) many[s] = nextMany[s];
      if (v <= 13) one[v] = true;
    }
    for (let s = 2; s <= 13; s++) {
      if (many[s] && this._rankIsLegalSomehow(rankFromValue(s), s, othersAlive)) return true;
    }
    return false;
  }

  /**
   * 給某位玩家（或觀戰者）看的畫面資料。
   * 別人的手牌只給張數；陣營模式隨機分隊時，隊員身分只有本人、國王、已出局者會公開。
   */
  getView(viewerId) {
    const viewer = this.players.find((p) => p.id === viewerId) || null;
    return {
      mode: this.mode,
      teamVisibility: this.teamVisibility,
      total: this.total,
      direction: this.direction,
      currentId: this.currentId,
      phase: this.phase,
      turn: this.turn,
      pending: this.pending ? { ...this.pending } : null,
      deckCount: this.deck.length,
      lastPlay: this.lastPlay,
      winner: this.winner,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        handCount: p.hand.length,
        isKing: p.isKing,
        team: this._teamVisibleTo(p, viewer),
        eliminatedReason: p.eliminatedReason,
      })),
      you: viewer
        ? { id: viewer.id, hand: viewer.hand.map((c) => ({ ...c })), team: viewer.team, alive: viewer.alive }
        : null,
    };
  }

  // ---------- 玩家動作 ----------

  /**
   * 出牌。
   * cardIds: 一張是單張出牌，兩張以上是組合出牌
   * choice: 10 或 Q（含組合成 10、Q）時必填，'+' 或 '-'
   * targetId: A、5、7、Joker（含組合成 5、7）時必填
   */
  play(playerId, { cardIds, choice, targetId } = {}) {
    this._requirePhase('playing');
    this._requireCurrent(playerId);
    const player = this.getPlayer(playerId);

    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new GameError('NO_CARDS', '請選擇要出的牌');
    }
    if (new Set(cardIds).size !== cardIds.length) {
      throw new GameError('DUP_CARDS', '同一張牌不能選兩次');
    }
    const cards = cardIds.map((id) => {
      const c = player.hand.find((x) => x.id === id);
      if (!c) throw new GameError('NOT_IN_HAND', '你手上沒有這張牌');
      return c;
    });

    const eff = this._effective(cards);
    const rank = eff.rank;

    // ---- 先檢查是否合法，全部通過才改變狀態 ----
    let target = null;
    if (TARGET_RANKS.has(rank)) {
      if (!targetId) throw new GameError('NEED_TARGET', '這張牌需要指定一位玩家');
      if (targetId === playerId) throw new GameError('TARGET_SELF', '不能指定自己');
      target = this.getPlayer(targetId);
      if (!target.alive) throw new GameError('TARGET_DEAD', '不能指定已出局的玩家');
    }

    let newTotal = this.total;
    if (NUMBER_RANKS.has(rank)) {
      newTotal = this.total + RANK_VALUE[rank];
    } else if (rank === '10' || rank === 'Q') {
      if (choice !== '+' && choice !== '-') {
        throw new GameError('NEED_CHOICE', '請選擇加或減');
      }
      const amount = rank === '10' ? 10 : 20;
      newTotal = choice === '+' ? this.total + amount : Math.max(MIN_TOTAL, this.total - amount);
    } else if (rank === 'K') {
      newTotal = MAX_TOTAL;
    }
    if (newTotal > MAX_TOTAL) {
      throw new GameError('OVER_99', '總數會超過 99，不能這樣出');
    }

    // ---- 執行 ----
    const events = [];
    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    this.discard.push(...cards);
    const before = this.total;
    this.total = newTotal;
    this.lastPlay = {
      playerId,
      cards: cards.map((c) => ({ ...c })),
      as: rank,
      combo: eff.combo,
      choice: choice || null,
      targetId: target ? target.id : null,
      totalBefore: before,
      totalAfter: newTotal,
    };
    events.push({ type: 'play', ...this.lastPlay });

    let nextOverride = null;

    if (rank === '4') {
      this.direction *= -1;
      events.push({ type: 'reverse', direction: this.direction });
    } else if (rank === '5') {
      nextOverride = target.id;
      events.push({ type: 'designate', playerId, targetId: target.id });
    } else if (rank === '7') {
      const idx = Math.floor(this.rng() * target.hand.length);
      const [stolen] = target.hand.splice(idx, 1);
      player.hand.push(stolen);
      events.push({ type: 'steal', playerId, targetId: target.id, card: { ...stolen } });
      if (target.hand.length === 0) this._eliminate(target, 'emptyHand', events);
    } else if (rank === 'A') {
      const mine = player.hand;
      player.hand = target.hand;
      target.hand = mine;
      events.push({ type: 'swap', playerId, targetId: target.id });
      if (target.hand.length === 0) this._eliminate(target, 'emptyHand', events);
      if (player.alive && player.hand.length === 0) this._eliminate(player, 'emptyHand', events);
    } else if (rank === 'JOKER') {
      if (target.hand.length <= 1) {
        events.push({ type: 'jokerResolved', playerId, targetId: target.id, discarded: 0 });
      } else {
        this.pending = { type: 'jokerKeep', byId: playerId, targetId: target.id };
        events.push({ type: 'jokerPending', playerId, targetId: target.id });
      }
    }

    // 抽牌（A、7 不抽）
    if (player.alive && !NO_DRAW_RANKS.has(rank) && this.phase !== 'ended') {
      const drawn = this._drawOne(player);
      if (drawn) events.push({ type: 'draw', playerId, card: { ...drawn } });
    }
    if (player.alive && player.hand.length === 0) this._eliminate(player, 'emptyHand', events);

    if (this.phase === 'ended') return events;
    if (this.pending) {
      this.phase = 'awaitJokerKeep';
      return events;
    }
    this._advance(nextOverride, events);
    return events;
  }

  /** 被鬼牌指定的人選擇要留下的那張牌。 */
  chooseJokerKeep(playerId, keepCardId) {
    this._requirePhase('awaitJokerKeep');
    if (!this.pending || this.pending.targetId !== playerId) {
      throw new GameError('NOT_YOUR_CHOICE', '現在不是你要選牌');
    }
    const target = this.getPlayer(playerId);
    const keep = target.hand.find((c) => c.id === keepCardId);
    if (!keep) throw new GameError('NOT_IN_HAND', '你手上沒有這張牌');

    const discarded = target.hand.filter((c) => c.id !== keepCardId);
    this.discard.push(...discarded);
    target.hand = [keep];
    const events = [{ type: 'jokerResolved', playerId: this.pending.byId, targetId: playerId, discarded: discarded.length }];
    this.pending = null;
    this.phase = 'playing';
    this._advance(null, events);
    return events;
  }

  /** 無牌可出時引爆（玩家按下按鈕，或伺服器 10 秒倒數到時呼叫）。 */
  detonate(playerId) {
    this._requirePhase('awaitDetonate');
    this._requireCurrent(playerId);
    const events = [];
    this._eliminate(this.getPlayer(playerId), 'noMove', events);
    if (this.phase !== 'ended') {
      this.phase = 'playing';
      this._advance(null, events);
    }
    return events;
  }

  /** 斷線逾時被踢出，視同出局。 */
  removePlayer(playerId, reason = 'kicked') {
    const p = this.getPlayer(playerId);
    const events = [];
    if (!p.alive || this.phase === 'ended') return events;

    const wasCurrent = this.currentId === playerId;
    const wasJokerTarget = this.pending && this.pending.targetId === playerId;
    if (wasJokerTarget) this.pending = null;

    this._eliminate(p, reason, events);
    if (this.phase === 'ended') return events;

    if (wasJokerTarget) {
      // 被鬼牌指定的人離開了：鬼牌結算完畢，輪到出鬼牌者的下一位
      this.phase = 'playing';
      this._advance(null, events);
    } else if (wasCurrent && this.phase !== 'awaitJokerKeep') {
      this.phase = 'playing';
      this._advance(null, events);
    }
    // 若出鬼牌的人自己被踢、對方還在選牌，等對方選完再往下輪
    return events;
  }

  // ---------- 內部工具 ----------

  _assignTeams(teamAssignment, manualTeams) {
    if (teamAssignment === 'manual') {
      if (!manualTeams) throw new GameError('NEED_TEAMS', '手動分隊需要提供每個人的隊伍');
      for (const p of this.players) {
        const t = manualTeams[p.id];
        if (t !== 'red' && t !== 'black') throw new GameError('NEED_TEAMS', '每位玩家都要選紅隊或黑隊');
        p.team = t;
      }
    } else {
      const shuffled = shuffle(this.players.slice(), this.rng);
      const n = shuffled.length;
      // 奇數人時，隨機決定哪一隊多一人
      const redCount = n % 2 === 0 ? n / 2 : (this.rng() < 0.5 ? Math.ceil(n / 2) : Math.floor(n / 2));
      shuffled.forEach((p, i) => { p.team = i < redCount ? 'red' : 'black'; });
    }
    for (const team of ['red', 'black']) {
      const members = this.players.filter((p) => p.team === team);
      if (members.length === 0) throw new GameError('EMPTY_TEAM', '紅隊和黑隊都至少要有一人');
      members[Math.floor(this.rng() * members.length)].isKing = true;
    }
  }

  _effective(cards) {
    if (cards.length === 1) return { rank: cards[0].rank, combo: false };
    if (cards.some((c) => c.rank === 'JOKER')) {
      throw new GameError('COMBO_JOKER', '鬼牌不能參與組合');
    }
    const sum = cards.reduce((s, c) => s + RANK_VALUE[c.rank], 0);
    if (sum < 2 || sum > 13) {
      throw new GameError('COMBO_RANGE', '組合的點數加總必須在 2～13 之間');
    }
    return { rank: rankFromValue(sum), combo: true, sum };
  }

  // 某個點數的牌在目前總數下，有沒有至少一種合法打法
  _rankIsLegalSomehow(rank, value, othersAlive) {
    if (TARGET_RANKS.has(rank)) return othersAlive;
    if (NUMBER_RANKS.has(rank)) return this.total + value <= MAX_TOTAL;
    return true; // 4、J、K、10（減）、Q（減）永遠可以出
  }

  _drawOne(player) {
    if (this.deck.length === 0) {
      if (this.discard.length === 0) return null;
      this.deck = shuffle(this.discard, this.rng);
      this.discard = [];
    }
    const card = this.deck.pop();
    player.hand.push(card);
    return card;
  }

  _eliminate(player, reason, events) {
    if (!player.alive) return;
    player.alive = false;
    player.eliminatedReason = reason;
    // 出局者的手牌收回牌堆
    this.deck.push(...player.hand);
    player.hand = [];
    shuffle(this.deck, this.rng);
    events.push({
      type: 'eliminated',
      playerId: player.id,
      reason,
      team: this.mode === 'team' ? player.team : undefined,
      isKing: player.isKing,
    });
    this._checkWin(events);
  }

  _checkWin(events) {
    if (this.phase === 'ended') return;
    if (this.mode === 'team') {
      const deadKing = this.players.find((p) => p.isKing && !p.alive);
      if (deadKing) {
        const team = deadKing.team === 'red' ? 'black' : 'red';
        this.winner = { type: 'team', team };
      }
    } else {
      const alive = this.alivePlayers();
      if (alive.length <= 1) this.winner = { type: 'player', playerId: alive[0] ? alive[0].id : null };
    }
    if (this.winner) {
      this.phase = 'ended';
      this.pending = null;
      events.push({ type: 'gameOver', winner: this.winner });
    }
  }

  _nextAliveIndex(fromIndex, direction) {
    const n = this.players.length;
    let i = fromIndex;
    for (let step = 0; step < n; step++) {
      i = (i + direction + n) % n;
      if (this.players[i].alive) return i;
    }
    return fromIndex;
  }

  _advance(overrideId, events) {
    if (overrideId) {
      this.currentIndex = this.players.findIndex((p) => p.id === overrideId);
    } else {
      this.currentIndex = this._nextAliveIndex(this.currentIndex, this.direction);
    }
    this.turn += 1;
    events.push({ type: 'turn', currentId: this.currentId, turn: this.turn });
    this._checkTurnStart(events);
  }

  _checkTurnStart(events) {
    if (this.phase === 'ended') return;
    if (this.hasLegalMove(this.currentId)) {
      this.phase = 'playing';
    } else {
      this.phase = 'awaitDetonate';
      events.push({ type: 'mustDetonate', playerId: this.currentId });
    }
  }

  _teamVisibleTo(p, viewer) {
    if (this.mode !== 'team') return null;
    if (this.teamVisibility === 'public') return p.team;
    if (this.phase === 'ended') return p.team;
    if (p.isKing || !p.alive) return p.team;
    if (viewer && viewer.id === p.id) return p.team;
    return null;
  }

  _requirePhase(phase) {
    if (this.phase !== phase) throw new GameError('BAD_PHASE', '現在不能做這個動作');
  }

  _requireCurrent(playerId) {
    if (this.currentId !== playerId) throw new GameError('NOT_YOUR_TURN', '還沒輪到你');
  }
}

/**
 * 把事件轉成某位觀看者可以知道的版本。
 * 抽到什麼牌、偷到什麼牌，只有當事人看得到；其他人只知道「抽了一張」。
 */
function redactEvent(event, viewerId) {
  if (event.type === 'draw' && event.playerId !== viewerId) {
    const { card, ...rest } = event;
    return rest;
  }
  if (event.type === 'steal' && event.playerId !== viewerId && event.targetId !== viewerId) {
    const { card, ...rest } = event;
    return rest;
  }
  return event;
}

module.exports = { Game, GameError, redactEvent, MAX_TOTAL };

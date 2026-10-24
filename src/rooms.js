'use strict';

const crypto = require('crypto');
const { Game, GameError, redactEvent } = require('./engine');

// 房號用的字元：英文字母和數字，去掉容易看錯的 I、O、0、1
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_PLAYERS = 10;
const MAX_MEMBERS = 30; // 玩家加觀戰者的上限
const NAME_MAX = 12;
const CHAT_MAX = 200;
const CHAT_KEEP = 100;
const LOG_KEEP = 300;
const LOG_SEND = 80;
const EMOTE_COOLDOWN_MS = 3000;
// 挑釁表情：只傳代號，文字由畫面決定，避免被塞入任意內容
const EMOTES = new Set(['ready', 'hurry', 'thatsit', 'boom', 'please', 'scared', 'respect', 'gg', 'help', 'king']);

/**
 * 房間管理：開房、加入、房主、斷線重連、觀戰、再來一局、聊天。
 * 不直接碰網路連線，而是透過 send(socketId, eventName, payload) 把資料送出去，方便測試。
 *
 * 身分識別：
 *   token     只有玩家本人知道的通行碼，存在他的瀏覽器裡，用來斷線後重連
 *   member.id 公開的玩家代號，所有人都看得到
 */
class RoomManager {
  constructor({
    send,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    reconnectMs = 90_000,
    detonateMs = 10_000,
    rng = Math.random,
    newToken = () => crypto.randomBytes(18).toString('base64url'),
  } = {}) {
    this.send = send;
    this.timers = timers;
    this.now = now;
    this.reconnectMs = reconnectMs;
    this.detonateMs = detonateMs;
    this.rng = rng;
    this.newToken = newToken;

    this.rooms = new Map(); // 房號 → 房間
    this.bySocket = new Map(); // socketId → { code, memberId }
    this.byToken = new Map(); // token → { code, memberId }
    this.idSeq = 0;
  }

  // ---------- 進出房間 ----------

  createRoom(socketId, { name } = {}) {
    this._leaveCurrent(socketId);
    const cleanName = this._cleanName(name);
    const code = this._newCode();
    const room = {
      code,
      hostId: null,
      members: [],
      settings: { mode: 'solo', teamAssignment: 'random' },
      status: 'lobby', // lobby | playing | ended
      game: null,
      log: [],
      logSeq: 0,
      chat: [],
      chatSeq: 0,
      detonate: { timer: null, key: null, deadline: null },
    };
    this.rooms.set(code, room);
    const member = this._addMember(room, cleanName, 'player');
    room.hostId = member.id;
    this._bind(socketId, room, member);
    this._broadcast(room);
    return { token: member.token, code, memberId: member.id };
  }

  joinRoom(socketId, { name, code } = {}) {
    const room = this.rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new GameError('ROOM_NOT_FOUND', '找不到這個房間，請確認房號');
    this._leaveCurrent(socketId);
    const cleanName = this._cleanName(name);
    if (room.members.some((m) => m.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new GameError('NAME_TAKEN', '房間裡已經有人用這個暱稱了');
    }
    if (room.members.length >= MAX_MEMBERS) {
      throw new GameError('ROOM_FULL', '房間人數已滿');
    }
    const players = room.members.filter((m) => m.role === 'player').length;
    const role = room.status === 'lobby' && players < MAX_PLAYERS ? 'player' : 'spectator';
    const member = this._addMember(room, cleanName, role);
    if (!room.hostId) room.hostId = member.id;
    this._bind(socketId, room, member);
    this._roomLog(room, { type: 'join', memberId: member.id, name: member.name, role });
    this._broadcast(room);
    return { token: member.token, code: room.code, memberId: member.id, role };
  }

  /** 斷線後用 token 回到原本的房間和座位。 */
  resume(socketId, { token } = {}) {
    const entry = this.byToken.get(token);
    if (!entry) throw new GameError('SESSION_EXPIRED', '連線已失效，請重新加入房間');
    const room = this.rooms.get(entry.code);
    const member = room && room.members.find((m) => m.id === entry.memberId);
    if (!member) throw new GameError('SESSION_EXPIRED', '連線已失效，請重新加入房間');
    const wasDisconnected = !member.connected;
    this._bind(socketId, room, member);
    if (!room.hostId) room.hostId = member.id;
    if (wasDisconnected) this._roomLog(room, { type: 'reconnect', memberId: member.id, name: member.name });
    this._broadcast(room);
    return { code: room.code, memberId: member.id, role: member.role };
  }

  leaveRoom(socketId) {
    const { room, member } = this._ctx(socketId);
    this._removeMember(room, member, 'left');
    return {};
  }

  /** 連線中斷：保留座位 90 秒，房主身分立刻交給下一位。 */
  disconnect(socketId) {
    const entry = this.bySocket.get(socketId);
    if (!entry) return;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(entry.code);
    const member = room && room.members.find((m) => m.id === entry.memberId);
    if (!member || member.socketId !== socketId) return;

    member.connected = false;
    member.socketId = null;
    if (this.closed) return;
    if (room.hostId === member.id) this._transferHost(room, member);
    member.timer = this.timers.setTimeout(() => {
      member.timer = null;
      if (!member.connected) this._removeMember(room, member, 'kicked');
    }, this.reconnectMs);
    member.disconnectDeadline = this.now() + this.reconnectMs;
    this._roomLog(room, { type: 'disconnect', memberId: member.id, name: member.name });
    this._broadcast(room);
  }

  // ---------- 房內設定（大廳） ----------

  setSettings(socketId, { mode, teamAssignment } = {}) {
    const { room, member } = this._ctx(socketId);
    this._requireHost(room, member);
    this._requireStatus(room, 'lobby');
    if (mode !== undefined) {
      if (mode !== 'solo' && mode !== 'team') throw new GameError('BAD_MODE', '未知的遊戲模式');
      room.settings.mode = mode;
    }
    if (teamAssignment !== undefined) {
      if (teamAssignment !== 'random' && teamAssignment !== 'manual') {
        throw new GameError('BAD_MODE', '未知的分隊方式');
      }
      room.settings.teamAssignment = teamAssignment;
    }
    this._broadcast(room);
    return {};
  }

  pickTeam(socketId, { team } = {}) {
    const { room, member } = this._ctx(socketId);
    this._requireStatus(room, 'lobby');
    if (room.settings.mode !== 'team' || room.settings.teamAssignment !== 'manual') {
      throw new GameError('BAD_PHASE', '目前不是手動分隊');
    }
    if (member.role !== 'player') throw new GameError('NOT_PLAYER', '觀戰者不能選隊');
    if (team !== 'red' && team !== 'black') throw new GameError('BAD_TEAM', '請選紅隊或黑隊');
    member.team = team;
    this._broadcast(room);
    return {};
  }

  startGame(socketId) {
    const { room, member } = this._ctx(socketId);
    this._requireHost(room, member);
    this._requireStatus(room, 'lobby');
    const players = room.members.filter((m) => m.role === 'player');
    const { mode, teamAssignment } = room.settings;
    let manualTeams = null;
    if (mode === 'team' && teamAssignment === 'manual') {
      manualTeams = {};
      for (const p of players) {
        if (!p.team) throw new GameError('NEED_TEAMS', p.name + ' 還沒選隊伍');
        manualTeams[p.id] = p.team;
      }
    }
    room.game = new Game({
      players: players.map((p) => ({ id: p.id, name: p.name })),
      mode,
      teamAssignment,
      manualTeams,
      rng: this.rng,
    });
    room.status = 'playing';
    room.log = [];
    this._afterGame(room, room.game.startEvents);
    return {};
  }

  // ---------- 遊戲中的動作 ----------

  action(socketId, payload = {}) {
    const { room, member } = this._ctx(socketId);
    this._requireStatus(room, 'playing');
    const game = room.game;
    if (!game.players.some((p) => p.id === member.id)) {
      throw new GameError('NOT_PLAYER', '觀戰者不能出牌');
    }
    let events;
    switch (payload.type) {
      case 'play': {
        const cardIds = payload.cardIds;
        if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 60
          || !cardIds.every((x) => typeof x === 'string')) {
          throw new GameError('NO_CARDS', '請選擇要出的牌');
        }
        events = game.play(member.id, {
          cardIds,
          choice: payload.choice === '+' || payload.choice === '-' ? payload.choice : undefined,
          targetId: typeof payload.targetId === 'string' ? payload.targetId : undefined,
        });
        break;
      }
      case 'jokerKeep':
        events = game.chooseJokerKeep(member.id, String(payload.cardId || ''));
        break;
      case 'detonate':
        events = game.detonate(member.id);
        break;
      default:
        throw new GameError('BAD_ACTION', '未知的動作');
    }
    this._afterGame(room, events);
    return {};
  }

  /** 一局結束後，房主帶大家回到大廳；觀戰者在有空位時自動成為玩家。 */
  backToLobby(socketId) {
    const { room, member } = this._ctx(socketId);
    this._requireHost(room, member);
    this._requireStatus(room, 'ended');
    this._clearDetonate(room);
    room.status = 'lobby';
    room.game = null;
    room.log = [];
    let players = room.members.filter((m) => m.role === 'player').length;
    for (const m of room.members) {
      if (m.role === 'spectator' && players < MAX_PLAYERS) {
        m.role = 'player';
        players += 1;
      }
    }
    this._broadcast(room);
    return {};
  }

  chat(socketId, { text } = {}) {
    const { room, member } = this._ctx(socketId);
    const clean = String(text || '').trim();
    if (!clean) throw new GameError('EMPTY_CHAT', '訊息不能是空的');
    if (Array.from(clean).length > CHAT_MAX) throw new GameError('CHAT_TOO_LONG', '訊息最多 ' + CHAT_MAX + ' 個字');
    const t = this.now();
    member.chatTimes = member.chatTimes.filter((x) => t - x < 5000);
    if (member.chatTimes.length >= 5) throw new GameError('CHAT_TOO_FAST', '訊息傳太快了，請稍等一下');
    member.chatTimes.push(t);
    room.chat.push({ id: ++room.chatSeq, memberId: member.id, name: member.name, text: clean, at: t });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    this._broadcast(room);
    return {};
  }

  /** 挑釁表情：遊戲中的玩家（含已出局）可以使用，每人每 3 秒一次。 */
  emote(socketId, { key } = {}) {
    const { room, member } = this._ctx(socketId);
    if (room.status !== 'playing' && room.status !== 'ended') {
      throw new GameError('BAD_PHASE', '遊戲開始後才能使用表情');
    }
    if (!room.game.players.some((p) => p.id === member.id)) {
      throw new GameError('NOT_PLAYER', '觀戰者不能使用表情');
    }
    if (!EMOTES.has(key)) throw new GameError('BAD_EMOTE', '沒有這個表情');
    const t = this.now();
    if (member.lastEmote && t - member.lastEmote < EMOTE_COOLDOWN_MS) {
      throw new GameError('EMOTE_TOO_FAST', '表情送太快了，等一下再送');
    }
    member.lastEmote = t;
    for (const m of room.members) {
      if (m.connected && m.socketId) this.send(m.socketId, 'emote', { memberId: member.id, key, at: t });
    }
    return {};
  }

  /** 伺服器關閉時清掉所有計時器。 */
  shutdown() {
    this.closed = true;
    for (const room of this.rooms.values()) {
      this._clearDetonate(room);
      for (const m of room.members) {
        if (m.timer) this.timers.clearTimeout(m.timer);
        m.timer = null;
      }
    }
  }

  // ---------- 內部工具 ----------

  _addMember(room, name, role) {
    const member = {
      id: 'm' + (++this.idSeq),
      token: this.newToken(),
      name,
      role,
      team: null,
      connected: false,
      socketId: null,
      timer: null,
      disconnectDeadline: null,
      chatTimes: [],
      lastEmote: 0,
    };
    room.members.push(member);
    this.byToken.set(member.token, { code: room.code, memberId: member.id });
    return member;
  }

  _bind(socketId, room, member) {
    if (member.socketId && member.socketId !== socketId) {
      // 同一位玩家從另一個分頁或裝置連進來，舊的連線就不再使用
      this.bySocket.delete(member.socketId);
      this.send(member.socketId, 'replaced', { message: '你已經從其他地方連線進入這個房間' });
    }
    const prev = this.bySocket.get(socketId);
    if (prev && (prev.code !== room.code || prev.memberId !== member.id)) this._leaveCurrent(socketId);
    if (member.timer) {
      this.timers.clearTimeout(member.timer);
      member.timer = null;
    }
    member.socketId = socketId;
    member.connected = true;
    member.disconnectDeadline = null;
    this.bySocket.set(socketId, { code: room.code, memberId: member.id });
  }

  _leaveCurrent(socketId) {
    const entry = this.bySocket.get(socketId);
    if (!entry) return;
    const room = this.rooms.get(entry.code);
    const member = room && room.members.find((m) => m.id === entry.memberId);
    if (member) this._removeMember(room, member, 'left');
    else this.bySocket.delete(socketId);
  }

  _removeMember(room, member, reason) {
    if (!room.members.includes(member)) return;
    if (member.timer) this.timers.clearTimeout(member.timer);
    member.timer = null;
    this.byToken.delete(member.token);
    if (member.socketId) this.bySocket.delete(member.socketId);

    room.members = room.members.filter((m) => m !== member);
    if (room.hostId === member.id) this._transferHost(room, member);
    this._roomLog(room, { type: 'leave', memberId: member.id, name: member.name, reason });

    if (room.members.length === 0) {
      this._clearDetonate(room);
      this.rooms.delete(room.code);
      return;
    }

    if (room.status === 'playing' && room.game) {
      const gp = room.game.players.find((p) => p.id === member.id);
      if (gp && gp.alive) {
        const events = room.game.removePlayer(member.id, reason === 'left' ? 'left' : 'kicked');
        this._afterGame(room, events);
        return;
      }
    }
    this._broadcast(room);
  }

  // 房主交給下一位在線的玩家（照座位順序），沒有玩家就交給在線的觀戰者
  _transferHost(room, oldHost) {
    const all = room.members;
    const start = Math.max(0, all.indexOf(oldHost));
    const ordered = all.slice(start + 1).concat(all.slice(0, start + 1)).filter((m) => m !== oldHost);
    const next = ordered.find((m) => m.connected && m.role === 'player')
      || ordered.find((m) => m.connected)
      || null;
    room.hostId = next ? next.id : null;
    if (next) this._roomLog(room, { type: 'host', memberId: next.id, name: next.name });
  }

  _afterGame(room, events) {
    for (const e of events) this._pushLog(room, e);
    const game = room.game;
    if (game.phase === 'ended') {
      room.status = 'ended';
      this._clearDetonate(room);
    } else if (game.phase === 'awaitDetonate') {
      const key = game.turn + ':' + game.currentId;
      if (room.detonate.key !== key) {
        this._clearDetonate(room);
        room.detonate.key = key;
        room.detonate.deadline = this.now() + this.detonateMs;
        room.detonate.timer = this.timers.setTimeout(() => {
          room.detonate.timer = null;
          if (room.game === game && game.phase === 'awaitDetonate' && game.turn + ':' + game.currentId === key) {
            const evs = game.detonate(game.currentId);
            this._afterGame(room, evs);
          }
        }, this.detonateMs);
      }
    } else {
      this._clearDetonate(room);
    }
    this._broadcast(room, events);
  }

  _clearDetonate(room) {
    if (room.detonate.timer) this.timers.clearTimeout(room.detonate.timer);
    room.detonate = { timer: null, key: null, deadline: null };
  }

  _pushLog(room, event) {
    room.log.push({ seq: ++room.logSeq, at: this.now(), ...event });
    if (room.log.length > LOG_KEEP) room.log.splice(0, room.log.length - LOG_KEEP);
  }

  _roomLog(room, event) {
    this._pushLog(room, { ...event, room: true });
  }

  _broadcast(room, newEvents = []) {
    for (const m of room.members) {
      if (m.connected && m.socketId) {
        this.send(m.socketId, 'state', this._stateFor(room, m, newEvents));
      }
    }
  }

  _stateFor(room, viewer, newEvents) {
    const showPicks = room.settings.mode === 'team' && room.settings.teamAssignment === 'manual';
    const game = room.game;
    return {
      code: room.code,
      status: room.status,
      settings: { ...room.settings },
      hostId: room.hostId,
      you: { id: viewer.id, name: viewer.name, role: viewer.role, isHost: room.hostId === viewer.id },
      members: room.members.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        connected: m.connected,
        disconnectDeadline: m.disconnectDeadline,
        team: showPicks && room.status === 'lobby' ? m.team : null,
      })),
      game: game
        ? { ...game.getView(viewer.id), detonateDeadline: room.detonate.deadline }
        : null,
      serverNow: this.now(),
      log: room.log.slice(-LOG_SEND).map((e) => redactEvent(e, viewer.id)),
      newEvents: newEvents.map((e) => redactEvent(e, viewer.id)),
      chat: room.chat.slice(-50),
    };
  }

  _ctx(socketId) {
    const entry = this.bySocket.get(socketId);
    const room = entry && this.rooms.get(entry.code);
    const member = room && room.members.find((m) => m.id === entry.memberId);
    if (!member) throw new GameError('NOT_IN_ROOM', '你不在任何房間裡');
    return { room, member };
  }

  _requireHost(room, member) {
    if (room.hostId !== member.id) throw new GameError('NOT_HOST', '只有房主可以這樣做');
  }

  _requireStatus(room, status) {
    if (room.status !== status) throw new GameError('BAD_PHASE', '現在不能做這個動作');
  }

  _cleanName(name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    const len = Array.from(clean).length;
    if (len === 0) throw new GameError('BAD_NAME', '請輸入暱稱');
    if (len > NAME_MAX) throw new GameError('BAD_NAME', '暱稱最多 ' + NAME_MAX + ' 個字');
    return clean;
  }

  _newCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_CHARS[Math.floor(this.rng() * CODE_CHARS.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError('NO_CODE', '目前房間太多，請稍後再試');
  }
}

module.exports = { RoomManager, CODE_CHARS, MAX_PLAYERS, EMOTES };

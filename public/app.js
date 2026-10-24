/* 血腥99 前端程式：畫面切換、牌桌繪製、出牌操作、連線與重連 */
(function () {
  'use strict';

  // ---------- 常數 ----------

  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const VALUE = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13 };
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const NUMBER = new Set(['2', '3', '6', '8', '9']);
  const TARGET = new Set(['A', '5', '7', 'JOKER']);
  const CHOICE = new Set(['10', 'Q']);
  const TEAM_NAME = { red: '紅隊', black: '黑隊' };
  const KEY_SESSION = 'b99.session';
  const KEY_NAME = 'b99.name';
  const KEY_MUTED = 'b99.muted';

  const ICON = {
    rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M8 7h7"/><path d="M8 11h5"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/></svg>',
    leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 16l-4-4 4-4"/><path d="M5 12h11"/></svg>',
    dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
    arrow: '<svg viewBox="-10 -10 20 20" aria-hidden="true"><path d="M-8 -8 L9 0 L-8 8 L-3 0 Z"/></svg>',
  };

  // ---------- 小工具 ----------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無法儲存時忽略 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } },
  };

  // ---------- 狀態 ----------

  let S = null; // 伺服器送來的最新狀態
  let offset = 0; // 伺服器時間 - 本機時間
  let screen = null;
  const names = new Map();
  const ui = {
    combo: false, // 組合模式
    sel: new Set(), // 組合模式中選取的牌
    choice: null, // 等待選加或減：{ cardIds, rank, combo }
    target: null, // 等待點選目標：{ cardIds, rank, combo }
    drawer: null, // 手機版展開的面板：'log' | 'chat'
    modal: null, // 'rules' | 'leave'
    hideEnd: false,
    busy: false,
  };

  const socket = io();
  window.B99 = { socket, get state() { return S; }, isMuted: () => !!store.get(KEY_MUTED) };

  function call(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        if (err) resolve({ ok: false, code: 'TIMEOUT', message: '連線逾時，請再試一次' });
        else resolve(res || { ok: false, message: '沒有回應' });
      });
    });
  }

  function now() { return Date.now() + offset; }
  function myId() { return S && S.you ? S.you.id : null; }
  function nm(id) { return id === myId() ? '你' : (names.get(id) || '某人'); }
  function member(id) { return S ? S.members.find((m) => m.id === id) : null; }
  function cardText(c) { return c.rank === 'JOKER' ? '鬼牌' : (SUIT[c.suit] || '') + c.rank; }
  function isRed(c) { return c.rank === 'JOKER' || c.suit === 'H' || c.suit === 'D'; }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // 單張或組合出牌時，實際當成哪一張牌
  function effective(cards) {
    if (cards.length === 0) return { error: '請選擇要出的牌' };
    if (cards.length === 1) return { rank: cards[0].rank, combo: false };
    if (cards.some((c) => c.rank === 'JOKER')) return { error: '鬼牌不能參與組合' };
    const sum = cards.reduce((s, c) => s + VALUE[c.rank], 0);
    if (sum > 13) return { error: '加總 ' + sum + '，超過 13 不能組合', sum };
    return { rank: RANKS[sum - 1], combo: true, sum };
  }

  // ---------- 畫面切換 ----------

  function show(name) {
    for (const id of ['home', 'lobby', 'game', 'message']) $('#screen-' + id).hidden = id !== name;
    screen = name;
    const chat = $('#chat-panel');
    if (name === 'lobby') { $('#lobby-side').appendChild(chat); chat.hidden = false; }
    else if (name === 'game') { $('#game-side').appendChild(chat); chat.hidden = false; }
    else chat.hidden = true;
    if (name !== 'game') { ui.drawer = null; applyDrawer(); }
  }

  function showMessage(title, text, btnLabel, onClick) {
    $('#message-title').textContent = title;
    $('#message-text').textContent = text || '';
    const btn = $('#message-btn');
    btn.hidden = !btnLabel;
    btn.textContent = btnLabel || '';
    btn.onclick = onClick || null;
    show('message');
  }

  function resetUi() {
    ui.combo = false; ui.sel.clear(); ui.choice = null; ui.target = null; ui.modal = null; ui.hideEnd = false;
  }

  function goHome(error) {
    S = null;
    resetUi();
    renderOverlay();
    show('home');
    $('#name-input').value = store.get(KEY_NAME) || $('#name-input').value;
    const hash = location.hash.replace('#', '').toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(hash)) $('#code-input').value = hash;
    $('#home-error').textContent = error || '';
  }

  // ---------- 連線 ----------

  showMessage('連線中…', '正在連上遊戲伺服器');

  socket.on('connect', async () => {
    $('#conn').hidden = true;
    const sess = store.get(KEY_SESSION);
    if (sess && sess.token) {
      if (!S) showMessage('連線中…', '正在回到你的房間');
      const r = await call('resume', { token: sess.token });
      if (!r.ok) {
        store.del(KEY_SESSION);
        goHome(r.code === 'SESSION_EXPIRED' ? '你已經不在那個房間了，可以重新加入。' : r.message);
      }
    } else if (!S) {
      goHome();
    }
  });

  socket.on('disconnect', () => { if (S) $('#conn').hidden = false; });

  socket.on('connect_error', () => {
    if (!S && screen === 'message') showMessage('連不上伺服器', '請確認網路連線，稍後會自動重試。');
  });

  socket.on('replaced', (p) => {
    S = null;
    resetUi();
    renderOverlay();
    showMessage('已在其他地方開啟', p && p.message, '在這裡繼續玩', async () => {
      const sess = store.get(KEY_SESSION);
      const r = sess ? await call('resume', { token: sess.token }) : { ok: false };
      if (!r.ok) goHome(r.message);
    });
  });

  socket.on('state', onState);

  function onState(s) {
    const prev = S;
    offset = s.serverNow - Date.now();
    for (const m of s.members) names.set(m.id, m.name);
    if (s.game) for (const p of s.game.players) names.set(p.id, p.name);
    for (const e of s.log) if (e.memberId && e.name) names.set(e.memberId, e.name);
    S = s;

    const g = s.game;
    const myTurn = g && g.phase === 'playing' && g.currentId === s.you.id && g.you && g.you.alive;
    if (!myTurn) {
      ui.combo = false; ui.sel.clear(); ui.choice = null; ui.target = null;
    } else {
      const ids = new Set(g.you.hand.map((c) => c.id));
      for (const id of Array.from(ui.sel)) if (!ids.has(id)) ui.sel.delete(id);
    }
    if (s.status !== 'ended') ui.hideEnd = false;
    if (ui.modal === 'leave' && s.status === 'lobby' && prev && prev.status !== 'lobby') ui.modal = null;
    if (location.hash !== '#' + s.code) history.replaceState(null, '', '#' + s.code);

    if (s.status === 'lobby') { show('lobby'); renderLobby(); }
    else { show('game'); renderGame(); }
    renderChat(prev);
    renderOverlay();

    if (window.B99Effects && s.newEvents && s.newEvents.length) {
      try { window.B99Effects.handle(s.newEvents, s, prev); } catch (e) { console.error(e); }
    }
    if (window.B99Effects && window.B99Effects.update) {
      try { window.B99Effects.update(s); } catch (e) { console.error(e); }
    }
  }

  // ---------- 首頁 ----------

  async function enterRoom(kind) {
    if (ui.busy) return;
    const name = $('#name-input').value.trim();
    const code = $('#code-input').value.trim().toUpperCase();
    const err = $('#home-error');
    if (!name) { err.textContent = '請先輸入暱稱'; $('#name-input').focus(); return; }
    if (kind === 'join' && code.length !== 4) { err.textContent = '請輸入 4 碼房號'; $('#code-input').focus(); return; }
    err.textContent = '';
    ui.busy = true;
    $('#create-btn').disabled = true;
    $('#join-btn').disabled = true;
    const r = kind === 'join' ? await call('joinRoom', { name, code }) : await call('createRoom', { name });
    ui.busy = false;
    $('#create-btn').disabled = false;
    $('#join-btn').disabled = false;
    if (!r.ok) { err.textContent = r.message; return; }
    store.set(KEY_NAME, name);
    store.set(KEY_SESSION, { token: r.token, code: r.code });
    if (r.role === 'spectator') toast('遊戲正在進行，你先觀戰，下一局就能加入');
  }

  $('#home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    enterRoom($('#code-input').value.trim() ? 'join' : 'create');
  });
  $('#create-btn').addEventListener('click', (e) => { e.preventDefault(); enterRoom('create'); });
  $('#join-btn').addEventListener('click', () => enterRoom('join'));
  $('#code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  // ---------- 大廳 ----------

  function memberItem(m) {
    const me = m.id === myId();
    const dc = !m.connected && m.disconnectDeadline
      ? '<span class="pill pill-dim" data-deadline="' + m.disconnectDeadline + '" data-tpl="斷線 {s} 秒"></span>' : '';
    return '<li class="member' + (me ? ' me' : '') + (m.connected ? '' : ' off') + '">'
      + '<div class="avatar">' + esc(Array.from(m.name)[0] || '?') + '</div>'
      + '<div><div>' + esc(m.name) + (me ? '（你）' : '') + '</div>'
      + '<div class="meta">' + (m.id === S.hostId ? '<span class="pill pill-host">房主</span> ' : '')
      + (m.role === 'spectator' ? '<span class="pill pill-dim">觀戰</span> ' : '') + dc + '</div></div></li>';
  }

  function seg(attr, current, options, enabled) {
    return '<div class="seg" role="group">' + options.map(([val, label]) =>
      '<button type="button" ' + attr + '="' + val + '" aria-pressed="' + (current === val) + '"' + (enabled ? '' : ' disabled') + '>' + label + '</button>').join('') + '</div>';
  }

  function startProblem(players, settings) {
    if (players.length < 2) return '至少要 2 位玩家才能開始';
    if (settings.mode === 'team' && players.length < 4) return '陣營模式至少要 4 位玩家';
    if (settings.mode === 'team' && settings.teamAssignment === 'manual') {
      if (players.some((p) => !p.team)) return '還有玩家沒選隊伍';
      if (!players.some((p) => p.team === 'red') || !players.some((p) => p.team === 'black')) return '紅隊和黑隊都至少要有一人';
    }
    return '';
  }

  function renderLobby() {
    const s = S;
    const host = s.you.isHost;
    const players = s.members.filter((m) => m.role === 'player');
    const specs = s.members.filter((m) => m.role === 'spectator');
    const team = s.settings.mode === 'team';
    const manual = team && s.settings.teamAssignment === 'manual';
    const meMember = member(myId());
    const iAmPlayer = meMember && meMember.role === 'player';

    let hint = '個人模式：最後存活的玩家獲勝。';
    if (team && !manual) hint = '陣營模式：擊倒對方國王就獲勝。隨機分隊，隊員身分只有自己知道；國王開局公開。';
    if (manual) hint = '陣營模式：擊倒對方國王就獲勝。手動分隊時，大家的隊伍一開始就公開；國王隨機產生。';
    if (!host) hint += '只有房主可以更改設定。';

    let html = '<section class="invite">'
      + '<div><div class="muted">房號</div><div class="invite-code">' + esc(s.code) + '</div></div>'
      + '<button class="btn" type="button" data-copy>複製邀請連結</button>'
      + '<p>朋友打開邀請連結，或在首頁輸入房號，就能加入這個房間。</p></section>';

    html += '<section class="lobby-section"><h2>遊戲設定</h2>'
      + '<div class="settings-row"><span>模式</span>' + seg('data-set-mode', s.settings.mode, [['solo', '個人模式'], ['team', '陣營模式']], host) + '</div>'
      + (team ? '<div class="settings-row"><span>分隊</span>' + seg('data-set-assign', s.settings.teamAssignment, [['random', '隨機分隊'], ['manual', '手動分隊']], host) + '</div>' : '')
      + '<p class="hint">' + hint + '</p></section>';

    html += '<section class="lobby-section"><h2>玩家 ' + players.length + ' / 10</h2>';
    if (manual) {
      const col = (t) => {
        const list = players.filter((p) => p.team === t);
        const mine = iAmPlayer && meMember.team === t;
        return '<div class="team-col ' + t + '"><h3>' + TEAM_NAME[t] + ' ' + list.length + ' 人</h3><ul>'
          + list.map((m) => '<li>' + esc(m.name) + (m.id === myId() ? '（你）' : '') + '</li>').join('') + '</ul>'
          + (iAmPlayer ? '<button type="button" class="btn' + (mine ? ' btn-on' : '') + '" data-team="' + t + '"' + (mine ? ' disabled' : '') + '>' + (mine ? '你在' + TEAM_NAME[t] : '加入' + TEAM_NAME[t]) + '</button>' : '')
          + '</div>';
      };
      const none = players.filter((p) => !p.team);
      html += '<div class="teams">' + col('red') + col('black') + '</div>';
      if (none.length) html += '<p class="hint">還沒選隊伍：' + none.map((m) => esc(m.name)).join('、') + '</p>';
    } else {
      html += '<ul class="member-list">' + players.map(memberItem).join('') + '</ul>';
    }
    html += '</section>';

    if (specs.length) {
      html += '<section class="lobby-section"><h2>觀戰 ' + specs.length + '</h2><ul class="member-list">' + specs.map(memberItem).join('') + '</ul></section>';
    }

    const problem = startProblem(players, s.settings);
    html += '<section class="lobby-start">'
      + (host
        ? '<button type="button" class="btn btn-blood" data-start' + (problem ? ' disabled' : '') + '>開始遊戲</button><span class="muted">' + esc(problem) + '</span>'
        : '<span class="muted">等待房主開始遊戲</span>')
      + '</section>';

    $('#lobby-main').innerHTML = html;
    tick();
  }

  $('#lobby-main').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.hasAttribute('data-copy')) {
      const link = location.origin + location.pathname + '#' + S.code;
      try { await navigator.clipboard.writeText(link); toast('已複製邀請連結'); }
      catch (err) { toast('邀請連結：' + link); }
      return;
    }
    let r = null;
    if (t.dataset.setMode) r = await call('setSettings', { mode: t.dataset.setMode });
    else if (t.dataset.setAssign) r = await call('setSettings', { teamAssignment: t.dataset.setAssign });
    else if (t.dataset.team) r = await call('pickTeam', { team: t.dataset.team });
    else if (t.hasAttribute('data-start')) r = await call('startGame');
    if (r && !r.ok) toast(r.message);
  });

  // ---------- 牌桌 ----------

  function renderGame() {
    const s = S;
    const g = s.game;
    $('#game-code').textContent = s.code;
    $('#game-mode').textContent = g.mode === 'team' ? (g.teamVisibility === 'public' ? '陣營模式（公開分隊）' : '陣營模式') : '個人模式';
    $('#game-alive').textContent = '存活 ' + g.players.filter((p) => p.alive).length + ' / ' + g.players.length;
    renderHand();
    renderStatus();
    renderLog();
    renderTable(); // 最後量牌桌大小，手牌區已經排好
    tick();
  }

  function isNarrow() { return window.matchMedia('(max-width: 820px)').matches; }

  function renderTable() {
    const s = S;
    const g = s.game;
    const el = $('#table');
    const w = el.clientWidth;
    const h = el.clientHeight;
    const narrow = isNarrow();
    const n = g.players.length;
    const myIdx = g.players.findIndex((p) => p.id === s.you.id);
    const base = myIdx >= 0 ? myIdx : 0;
    const sw = narrow ? 76 : 132;
    const sh = narrow ? 84 : 104;
    const rx = Math.max(60, w / 2 - sw / 2 - 6);
    const ry = Math.max(60, h / 2 - sh / 2 - 4);

    // 座位：自己固定在最下方，其他人照出牌順序（順時針）排開
    let seats = '';
    g.players.forEach((p, i) => {
      const rel = (i - base + n) % n;
      const ang = (90 + rel * 360 / n) * Math.PI / 180;
      const x = w / 2 + rx * Math.cos(ang);
      const y = h / 2 + ry * Math.sin(ang);
      const m = member(p.id);
      const me = p.id === s.you.id;
      const turn = p.id === g.currentId && g.phase !== 'ended' && p.alive;
      const targetable = !!ui.target && p.alive && !me;
      const cls = ['seat', me && 'me', turn && 'turn', !p.alive && 'dead', targetable && 'targetable'].filter(Boolean).join(' ');
      const reason = { noMove: '引爆出局', emptyHand: '手牌歸零', kicked: '斷線出局', left: '離開' }[p.eliminatedReason] || '出局';
      let info = p.alive ? '<span>' + (narrow ? '×' : '手牌 ') + p.handCount + '</span>' : '<span class="bad">' + reason + '</span>';
      if (p.isKing) info += '<span class="pill pill-' + p.team + '">' + (p.team === 'red' ? '紅王' : '黑王') + '</span>';
      else if (p.team) info += '<span class="pill pill-' + p.team + '">' + (narrow ? TEAM_NAME[p.team][0] : TEAM_NAME[p.team]) + '</span>';
      if (p.alive && m && !m.connected && m.disconnectDeadline) {
        info += '<span class="bad" data-deadline="' + m.disconnectDeadline + '" data-tpl="斷線 {s}"></span>';
      }
      seats += '<button type="button" class="' + cls + '" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px" data-seat="' + esc(p.id) + '"'
        + (targetable ? '' : ' disabled') + ' aria-label="' + esc((me ? '你' : p.name) + (targetable ? '，點選指定' : '')) + '">'
        + '<span class="avatar">' + esc(Array.from(p.name)[0] || '?') + '</span>'
        + '<span class="nm">' + esc(me ? '你' : p.name) + '</span>'
        + '<span class="info">' + info + '</span></button>';
    });
    $('#seats').innerHTML = seats;

    // 方向箭頭，沿著桌面的虛線圈
    const ringX = w * (0.5 - (narrow ? 0.27 : 0.22));
    const ringY = h * (0.5 - (narrow ? 0.22 : 0.21));
    $('#arrows').innerHTML = [45, 135, 225, 315].map((d) => {
      const t = d * Math.PI / 180;
      const x = w / 2 + ringX * Math.cos(t);
      const y = h / 2 + ringY * Math.sin(t);
      let deg = Math.atan2(ringY * Math.cos(t), -ringX * Math.sin(t)) * 180 / Math.PI;
      if (g.direction !== 1) deg += 180;
      return '<div class="arrow" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;transform:rotate(' + deg.toFixed(1) + 'deg)">' + ICON.arrow + '</div>';
    }).join('');

    const lp = g.lastPlay;
    const lastShort = lp ? nm(lp.playerId) + '：' + lp.cards.map(cardText).join('+') + (lp.combo ? '＝' + lp.as : '') : '';
    $('#center').innerHTML = '<div class="label">目前總數</div>'
      + '<div class="total" id="total">' + g.total + '</div>'
      + '<div class="mini">' + esc(lastShort ? '上一手 ' + lastShort : '還沒有人出牌') + '</div>'
      + '<div class="mini">牌堆 ' + g.deckCount + ' 張</div>'
      + '<div class="dir' + (g.direction === 1 ? '' : ' ccw') + '">' + ICON.dir + '<span>' + (g.direction === 1 ? '順時針' : '逆時針') + '</span></div>';

    $('#deck').innerHTML = '<div class="card-back"><span>99</span></div><div>牌堆 ' + g.deckCount + ' 張</div>';
    $('#last-play').innerHTML = lp
      ? '<div>上一手</div><div class="last-cards">' + lp.cards.map(miniCard).join('') + '</div>'
        + '<div class="what">' + esc(nm(lp.playerId)) + '<br><em>' + esc(playShort(lp)) + '</em></div>'
      : '<div>還沒有人出牌</div>';

  }

  function miniCard(c) {
    if (c.rank === 'JOKER') return '<div class="mini-card joker">JOKER</div>';
    return '<div class="mini-card' + (isRed(c) ? ' red' : '') + '"><span class="r">' + esc(c.rank) + '</span>' + SUIT[c.suit] + '</div>';
  }

  function playShort(lp) {
    const parts = [];
    if (lp.combo) parts.push('當 ' + lp.as);
    if (lp.as === '10' || lp.as === 'Q') parts.push((lp.choice === '+' ? '加 ' : '減 ') + (lp.as === '10' ? 10 : 20));
    else if (NUMBER.has(lp.as)) parts.push('加 ' + VALUE[lp.as]);
    else if (lp.as === 'K') parts.push('變成 99');
    else if (lp.as === 'J') parts.push('PASS');
    else if (lp.as === '4') parts.push('迴轉');
    if (lp.targetId) parts.push('指定' + nm(lp.targetId));
    return parts.join('，');
  }

  function cardButton(c, opts) {
    const cls = ['card', isRed(c) && 'red', c.rank === 'JOKER' && 'joker', opts.sel && 'sel', opts.dim && 'dim', opts.playable && 'playable'].filter(Boolean).join(' ');
    const inner = c.rank === 'JOKER'
      ? '<span class="big">JOKER</span>'
      : '<span class="r">' + esc(c.rank) + '</span><span class="s">' + SUIT[c.suit] + '</span><span class="big">' + SUIT[c.suit] + '</span>';
    return '<button type="button" class="' + cls + '" ' + opts.attr + '="' + esc(c.id) + '"' + (opts.playable ? '' : ' disabled')
      + ' aria-label="' + esc(cardText(c)) + (opts.sel ? '，已選取' : '') + '">' + inner + '</button>';
  }

  function myTurnNow() {
    const g = S && S.game;
    return !!(g && g.phase === 'playing' && g.currentId === myId() && g.you && g.you.alive);
  }

  function renderHand() {
    const g = S.game;
    const me = g.you;
    const handEl = $('#hand');
    const info = $('#hand-info');
    const buttons = $('#hand-buttons');

    if (!me) {
      info.innerHTML = '';
      handEl.innerHTML = '<div class="hand-empty">你正在觀戰，下一局就能加入。</div>';
      buttons.innerHTML = endButtons();
      return;
    }
    if (!me.alive) {
      info.innerHTML = '';
      handEl.innerHTML = '<div class="hand-empty">你已經出局了，可以繼續觀戰。</div>';
      buttons.innerHTML = endButtons();
      return;
    }

    const meP = g.players.find((p) => p.id === me.id);
    let teamNote = '';
    if (g.mode === 'team' && me.team) {
      teamNote = '<div class="team-note">你是' + TEAM_NAME[me.team] + (meP.isKing ? '國王' : '')
        + (g.teamVisibility === 'hidden' && !meP.isKing ? '<br>只有你看得到' : '') + '</div>';
    }
    info.innerHTML = '<div class="muted">你的手牌</div><div class="count">' + me.hand.length + ' 張</div>' + teamNote;

    const playable = myTurnNow() && !ui.target && !ui.choice;
    handEl.innerHTML = me.hand.map((c) => cardButton(c, {
      attr: 'data-card', playable, sel: ui.sel.has(c.id), dim: ui.combo && c.rank === 'JOKER',
    })).join('');

    if (myTurnNow() && ui.target) {
      buttons.innerHTML = '<button type="button" class="btn" data-cancel>取消指定</button>';
    } else if (myTurnNow()) {
      const sel = me.hand.filter((c) => ui.sel.has(c.id));
      const eff = effective(sel);
      const valid = ui.combo && sel.length >= 2 && !eff.error;
      buttons.innerHTML = '<button type="button" class="btn' + (ui.combo ? ' btn-on' : '') + '" data-combo aria-pressed="' + ui.combo + '"' + (playable ? '' : ' disabled') + '>' + (ui.combo ? '取消組合' : '組合') + '</button>'
        + '<button type="button" class="btn btn-blood" data-play-combo' + (valid && playable ? '' : ' disabled') + '>出牌</button>';
    } else {
      buttons.innerHTML = endButtons();
    }
  }

  function endButtons() {
    if (S.status === 'ended' && S.you.isHost) return '<button type="button" class="btn btn-blood" data-back-lobby>再來一局</button>';
    if (S.status === 'ended' && ui.hideEnd) return '<button type="button" class="btn" data-show-end>看結果</button>';
    return '';
  }

  function comboText() {
    const sel = S.game.you.hand.filter((c) => ui.sel.has(c.id));
    if (sel.length === 0) return '組合模式：點選要組合的牌，再按「出牌」';
    const expr = sel.map((c) => c.rank).join(' + ');
    const eff = effective(sel);
    if (sel.length === 1) return expr + '，至少要選兩張';
    if (eff.error) return '<span class="warn">' + esc(expr + ' = ' + eff.sum + '，超過 13 不能組合') + '</span>';
    return esc(expr + ' = ' + eff.sum + '，當 ' + eff.rank + ' 出');
  }

  function winnerText() {
    const w = S.game.winner;
    if (!w) return '';
    if (w.type === 'team') return TEAM_NAME[w.team] + '獲勝';
    return w.playerId === myId() ? '你活到了最後' : nm(w.playerId) + ' 活到了最後';
  }

  function renderStatus() {
    const g = S.game;
    const me = myId();
    let html;
    if (g.phase === 'ended') {
      html = '<span class="warn">遊戲結束：' + esc(winnerText()) + '</span>';
    } else if (g.phase === 'awaitDetonate') {
      html = g.currentId === me
        ? '<span class="warn">你沒有牌可以出了</span>'
        : esc(nm(g.currentId)) + ' 沒有牌可以出了，<span class="warn" data-deadline="' + g.detonateDeadline + '" data-tpl="{s} 秒後引爆"></span>';
    } else if (g.phase === 'awaitJokerKeep') {
      html = g.pending.targetId === me
        ? '<span class="warn">被鬼牌指定：選一張要留下的牌</span>'
        : '等待 ' + esc(nm(g.pending.targetId)) + ' 選擇要留下的牌';
    } else if (myTurnNow()) {
      if (ui.target) html = '<span class="warn">點選要指定的玩家</span>（' + esc(rankLabel(ui.target)) + '）';
      else if (ui.combo) html = comboText();
      else html = '<span class="warn">輪到你了</span>點一下牌就直接打出';
    } else {
      const m = member(g.currentId);
      html = '輪到 ' + esc(nm(g.currentId)) + ' 出牌';
      if (m && !m.connected && m.disconnectDeadline) {
        html += '，他斷線了，等待重新連線（<span data-deadline="' + m.disconnectDeadline + '" data-tpl="剩 {s} 秒"></span>）';
      }
    }
    $('#status-line').innerHTML = html;
  }

  function rankLabel(p) {
    const names = { A: 'A：交換手牌', 5: '5：指定下一位出牌', 7: '7：抽一張牌', JOKER: '鬼牌：對方只留一張手牌' };
    return (p.combo ? '組合當 ' : '') + (names[p.rank] || p.rank);
  }

  // ---------- 出牌流程 ----------

  function startPlay(cardIds) {
    const g = S.game;
    const cards = cardIds.map((id) => g.you.hand.find((c) => c.id === id)).filter(Boolean);
    const eff = effective(cards);
    if (eff.error) { toast(eff.error); return; }
    if (CHOICE.has(eff.rank)) { ui.choice = { cardIds, rank: eff.rank, combo: eff.combo }; renderAll(); return; }
    if (TARGET.has(eff.rank)) { ui.target = { cardIds, rank: eff.rank, combo: eff.combo }; renderAll(); return; }
    if (NUMBER.has(eff.rank) && g.total + VALUE[eff.rank] > 99) {
      toast('總數會超過 99，不能出' + (eff.combo ? '這個組合' : '這張'));
      return;
    }
    sendPlay({ cardIds });
  }

  async function sendPlay(p) {
    if (ui.busy) return;
    ui.busy = true;
    const r = await call('action', { type: 'play', ...p });
    ui.busy = false;
    if (!r.ok) { toast(r.message); ui.choice = null; ui.target = null; renderAll(); return; }
    ui.combo = false; ui.sel.clear(); ui.choice = null; ui.target = null;
    renderAll();
  }

  function renderAll() {
    if (!S) return;
    if (S.status === 'lobby') renderLobby(); else renderGame();
    renderOverlay();
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.dataset.card && !t.disabled) {
      const id = t.dataset.card;
      const c = S.game.you.hand.find((x) => x.id === id);
      if (ui.combo) {
        if (c.rank === 'JOKER') { toast('鬼牌不能參與組合'); return; }
        if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id);
        renderAll();
      } else {
        startPlay([id]);
      }
      return;
    }
    if (t.dataset.seat && ui.target && !t.disabled) {
      sendPlay({ cardIds: ui.target.cardIds, targetId: t.dataset.seat });
      return;
    }
    if (t.dataset.keep) {
      const r = await call('action', { type: 'jokerKeep', cardId: t.dataset.keep });
      if (!r.ok) toast(r.message);
      return;
    }
    if (t.dataset.choice && ui.choice) {
      sendPlay({ cardIds: ui.choice.cardIds, choice: t.dataset.choice });
      return;
    }
    if (t.hasAttribute('data-combo')) {
      ui.combo = !ui.combo; ui.sel.clear(); renderAll(); return;
    }
    if (t.hasAttribute('data-play-combo')) { startPlay(Array.from(ui.sel)); return; }
    if (t.hasAttribute('data-cancel')) { ui.choice = null; ui.target = null; renderAll(); return; }
    if (t.hasAttribute('data-detonate')) {
      const r = await call('action', { type: 'detonate' });
      if (!r.ok) toast(r.message);
      return;
    }
    if (t.hasAttribute('data-back-lobby')) {
      const r = await call('backToLobby');
      if (!r.ok) toast(r.message);
      return;
    }
    if (t.hasAttribute('data-hide-end')) { ui.hideEnd = true; renderAll(); return; }
    if (t.hasAttribute('data-show-end')) { ui.hideEnd = false; renderAll(); return; }
    if (t.hasAttribute('data-open-rules')) { ui.modal = 'rules'; renderOverlay(); return; }
    if (t.hasAttribute('data-close-modal')) { ui.modal = null; renderOverlay(); return; }
    if (t.hasAttribute('data-mute')) {
      const muted = !store.get(KEY_MUTED);
      store.set(KEY_MUTED, muted);
      paintMute();
      if (window.B99Effects && window.B99Effects.setMuted) window.B99Effects.setMuted(muted);
      toast(muted ? '已靜音' : '已開啟音效');
      return;
    }
    if (t.hasAttribute('data-leave')) {
      const g = S && S.game;
      const risky = S && S.status === 'playing' && g && g.you && g.you.alive;
      if (risky) { ui.modal = 'leave'; renderOverlay(); } else leave();
      return;
    }
    if (t.hasAttribute('data-confirm-leave')) { leave(); return; }
    if (t.dataset.drawer) { ui.drawer = t.dataset.drawer; applyDrawer(); return; }
    if (t.id === 'side-close') { ui.drawer = null; applyDrawer(); }
  });

  async function leave() {
    ui.modal = null;
    await call('leaveRoom');
    store.del(KEY_SESSION);
    history.replaceState(null, '', location.pathname);
    goHome();
  }

  function applyDrawer() {
    const side = $('#game-side');
    side.classList.toggle('open', !!ui.drawer);
    if (ui.drawer) {
      side.dataset.tab = ui.drawer;
      $('#side-title').textContent = ui.drawer === 'chat' ? '聊天室' : '行動紀錄';
      if (ui.drawer === 'chat') scrollChat(true);
    }
  }

  // ---------- 疊在畫面上的面板 ----------

  const RULES = [
    ['A', '和任一玩家交換手牌（不抽牌）'], ['4', '迴轉，出牌方向反轉'],
    ['5', '指定下一位出牌的人'], ['7', '抽任一玩家一張牌（不抽牌）'],
    ['10', '總數加 10 或減 10'], ['J', 'PASS，總數不變'],
    ['Q', '總數加 20 或減 20'], ['K', '總數直接變成 99'],
    ['鬼牌', '指定一位玩家只留一張手牌'], ['其他', '2、3、6、8、9 照點數加'],
  ];

  function renderOverlay() {
    const root = $('#overlay-root');
    let html = '';
    const g = S && S.game;
    const me = myId();

    if (ui.modal === 'rules') {
      html = '<div class="overlay"><div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="rules-title">'
        + '<h2 id="rules-title">規則速查</h2>'
        + '<p>總數從 99 開始，不能超過 99，最小是 0。輪到你時沒有牌可以出就出局；任何時候手牌歸零也立刻出局。每出一次牌抽一張。</p>'
        + '<p>組合出牌：把幾張牌的點數加起來，當成一張 2～13 的牌出（A=1、J=11、Q=12、K=13，鬼牌不能組合）。</p>'
        + '<div class="rules-grid">' + RULES.map(([k, v]) => '<div><b>' + k + '</b><span>' + v + '</span></div>').join('') + '</div>'
        + '<p>陣營模式：擊倒對方國王就獲勝。</p>'
        + '<div class="row"><button type="button" class="btn" data-close-modal>關閉</button></div></div></div>';
    } else if (ui.modal === 'leave') {
      html = '<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="leave-title">'
        + '<h2 id="leave-title">確定要離開嗎？</h2><p>遊戲進行中離開房間，會直接算出局。</p>'
        + '<div class="row"><button type="button" class="btn" data-close-modal>留下來</button>'
        + '<button type="button" class="btn btn-blood" data-confirm-leave>離開並出局</button></div></div></div>';
    } else if (g && screen === 'game') {
      if (g.phase === 'awaitDetonate' && g.currentId === me) {
        html = '<div class="overlay"><div class="sheet boom-sheet" role="dialog" aria-modal="true" aria-labelledby="boom-title">'
          + '<h2 id="boom-title">你沒有牌可以出了</h2>'
          + '<div class="count" data-deadline="' + g.detonateDeadline + '" data-tpl="{s}"></div>'
          + '<p>倒數結束會自動引爆</p>'
          + '<button type="button" class="btn btn-blood" data-detonate>引爆</button></div></div>';
      } else if (g.phase === 'awaitJokerKeep' && g.pending.targetId === me && g.you) {
        html = '<div class="overlay"><div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="keep-title">'
          + '<h2 id="keep-title">' + esc(nm(g.pending.byId)) + ' 對你出了鬼牌</h2>'
          + '<p>選一張要留下的牌，其他手牌會被丟掉。</p>'
          + '<div class="hand">' + g.you.hand.map((c) => cardButton(c, { attr: 'data-keep', playable: true })).join('') + '</div></div></div>';
      } else if (ui.choice) {
        const amt = ui.choice.rank === '10' ? 10 : 20;
        const up = g.total + amt;
        const down = Math.max(0, g.total - amt);
        html = '<div class="overlay soft"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="choice-title">'
          + '<h2 id="choice-title">' + (ui.choice.combo ? '組合當 ' : '打出 ') + ui.choice.rank + '：加還是減？</h2>'
          + '<p>目前總數 ' + g.total + '</p>'
          + '<div class="row"><button type="button" class="btn" data-choice="+"' + (up > 99 ? ' disabled' : '') + '>加 ' + amt + '（' + (up > 99 ? '超過 99' : '變 ' + up) + '）</button>'
          + '<button type="button" class="btn btn-blood" data-choice="-">減 ' + amt + '（變 ' + down + '）</button></div>'
          + '<button type="button" class="btn btn-ghost" data-cancel>取消</button></div></div>';
      } else if (S.status === 'ended' && !ui.hideEnd) {
        const w = g.winner;
        let sub = '';
        if (w.type === 'team' && g.you) sub = g.you.team === w.team ? '你的隊伍贏了。' : '你的隊伍輸了。';
        const list = g.players.map((p) => '<li>' + esc(p.id === me ? '你' : p.name)
          + (p.team ? ' <span class="pill pill-' + p.team + '">' + TEAM_NAME[p.team] + (p.isKing ? '國王' : '') + '</span>' : '')
          + ' <span class="muted">' + (p.alive ? '存活' : '出局') + '</span></li>').join('');
        html = '<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="end-title">'
          + '<p class="end-title" id="end-title">' + esc(winnerText()) + '</p>'
          + (sub ? '<p>' + sub + '</p>' : '')
          + '<ul class="end-list">' + list + '</ul>'
          + '<div class="row">'
          + '<button type="button" class="btn" data-hide-end>看牌桌</button>'
          + (S.you.isHost ? '<button type="button" class="btn btn-blood" data-back-lobby>再來一局</button>' : '')
          + '</div>'
          + (S.you.isHost ? '' : '<p>等待房主開始下一局。</p>')
          + '</div></div>';
      }
    }
    root.innerHTML = html;
    tick();
    const focusable = root.querySelector('[data-detonate], [data-choice="-"], [data-keep], [data-close-modal], [data-back-lobby], [data-hide-end]');
    if (focusable && !root.contains(document.activeElement)) focusable.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.modal) { ui.modal = null; renderOverlay(); }
    else if (ui.choice || ui.target) { ui.choice = null; ui.target = null; renderAll(); }
    else if (ui.drawer) { ui.drawer = null; applyDrawer(); }
  });

  // ---------- 行動紀錄 ----------

  function logLine(e) {
    const N = (id) => '<b>' + esc(nm(id)) + '</b>';
    const teamTag = (ev) => (ev.team ? '（' + TEAM_NAME[ev.team] + (ev.isKing ? '國王' : '') + '）' : '');
    switch (e.type) {
      case 'start': return { html: '開局：總數 99，' + N(e.currentId) + '先出牌，順時針' };
      case 'play': return { html: N(e.playerId) + playLine(e) };
      case 'reverse': return { html: '方向改為' + (e.direction === 1 ? '順時針' : '逆時針'), cls: 'sys' };
      case 'steal':
        if (e.card && e.playerId === myId()) return { html: '你抽到 ' + esc(cardText(e.card)), cls: 'sys' };
        if (e.card && e.targetId === myId()) return { html: '你被抽走 ' + esc(cardText(e.card)), cls: 'sys' };
        return null;
      case 'jokerResolved':
        return e.discarded > 0
          ? { html: N(e.targetId) + '丟掉 ' + e.discarded + ' 張手牌，只留下一張' }
          : { html: N(e.targetId) + '只有一張手牌，保留下來' };
      case 'eliminated': {
        const why = { noMove: '沒有牌可以出，引爆出局', emptyHand: '手牌歸零，出局', kicked: '斷線太久，出局', left: '離開房間，出局' }[e.reason] || '出局';
        return { html: N(e.playerId) + why + teamTag(e), cls: 'boom' };
      }
      case 'gameOver': {
        const w = e.winner;
        const text = w.type === 'team' ? TEAM_NAME[w.team] + '獲勝' : (w.playerId === myId() ? '你活到最後，獲勝' : esc(nm(w.playerId)) + ' 活到最後，獲勝');
        return { html: '遊戲結束：' + text, cls: 'boom' };
      }
      case 'join': return { html: esc(e.name) + ' 進入房間' + (e.role === 'spectator' ? '觀戰' : ''), cls: 'sys' };
      case 'leave': return { html: esc(e.name) + (e.reason === 'kicked' ? ' 斷線太久，被移出房間' : ' 離開房間'), cls: 'sys' };
      case 'disconnect': return { html: esc(e.name) + ' 斷線了', cls: 'sys' };
      case 'reconnect': return { html: esc(e.name) + ' 重新連線', cls: 'sys' };
      case 'host': return { html: esc(e.name) + ' 成為房主', cls: 'sys' };
      default: return null;
    }
  }

  function playLine(e) {
    const N = (id) => '<b>' + esc(nm(id)) + '</b>';
    const cards = e.cards.map(cardText).join(' + ');
    let t = e.combo ? '組合 ' + esc(cards) + ' 當 ' + e.as : '打出 ' + esc(cards);
    switch (e.as) {
      case '10': case 'Q': t += '，' + (e.choice === '+' ? '加 ' : '減 ') + (e.as === '10' ? 10 : 20); break;
      case 'K': t += '，總數變成 99'; break;
      case 'J': t += '，PASS'; break;
      case '4': t += '，迴轉'; break;
      case '5': t += '，指定' + N(e.targetId) + '出牌'; break;
      case '7': t += '，抽走' + N(e.targetId) + '一張牌'; break;
      case 'A': t += '，和' + N(e.targetId) + '交換手牌'; break;
      case 'JOKER': t += '，要' + N(e.targetId) + '只留一張手牌'; break;
      default: t += '，加 ' + VALUE[e.as];
    }
    if (e.totalBefore !== e.totalAfter && e.as !== 'K') t += '（' + e.totalBefore + ' → ' + e.totalAfter + '）';
    return t;
  }

  function renderLog() {
    const lines = S.log.slice().reverse().map(logLine).filter(Boolean).slice(0, 60);
    $('#log-list').innerHTML = lines.map((l) => '<li' + (l.cls ? ' class="' + l.cls + '"' : '') + '>' + l.html + '</li>').join('');
    $('#latest').innerHTML = lines[0] ? lines[0].html : '';
  }

  // ---------- 聊天室 ----------

  function renderChat(prev) {
    const list = $('#chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const msgs = S.chat;
    list.innerHTML = msgs.length
      ? msgs.map((m) => '<div><span class="who">' + esc(m.memberId === myId() ? '你' : m.name) + '：</span>' + esc(m.text) + '</div>').join('')
      : '<div class="chat-empty">還沒有人說話。</div>';
    const prevLast = prev && prev.chat.length ? prev.chat[prev.chat.length - 1].id : 0;
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    if (nearBottom || (last && last.id !== prevLast && last.memberId === myId())) scrollChat(true);
  }

  function scrollChat() {
    const list = $('#chat-list');
    list.scrollTop = list.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    const r = await call('chat', { text });
    if (r.ok) input.value = '';
    else toast(r.message);
  });

  // ---------- 倒數計時與靜音圖示 ----------

  function tick() {
    for (const el of $$('[data-deadline]')) {
      const d = Number(el.dataset.deadline);
      if (!d) continue;
      const secs = Math.max(0, Math.ceil((d - now()) / 1000));
      el.textContent = el.dataset.tpl.replace('{s}', secs);
    }
  }
  setInterval(tick, 250);

  function paintMute() {
    const muted = !!store.get(KEY_MUTED);
    for (const b of $$('[data-mute]')) {
      b.innerHTML = muted ? ICON.muted : ICON.sound;
      b.setAttribute('aria-label', muted ? '開啟音效' : '靜音');
    }
  }
  for (const b of $$('[data-open-rules]')) b.innerHTML = ICON.rules;
  for (const b of $$('.icon-btn[data-leave]')) b.innerHTML = ICON.leave;
  paintMute();

  // 牌桌大小改變時（視窗縮放、手牌數量變化、手機旋轉）重新排座位
  let lastSize = '';
  const relayout = () => {
    if (!S || screen !== 'game' || !S.game) return;
    const el = $('#table');
    const size = el.clientWidth + 'x' + el.clientHeight;
    if (size === lastSize) return;
    lastSize = size;
    renderTable();
    tick();
  };
  if (window.ResizeObserver) new ResizeObserver(relayout).observe($('#table'));
  window.addEventListener('resize', relayout);
})();

/* 血腥99 特效：依照伺服器送來的事件，在牌桌上播放動畫與音效 */
(function () {
  'use strict';

  const Sound = window.B99Sound;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);

  // ---------- 位置 ----------

  function centerOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function seatEl(id) {
    return document.querySelector('[data-seat="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  }
  function seatPoint(id) {
    const s = seatEl(id);
    return centerOf(s && s.querySelector('.avatar')) || centerOf(document.querySelector('#total'));
  }
  function deckPoint() {
    return centerOf(document.querySelector('#deck .card-back')) || centerOf(document.querySelector('#total'));
  }
  function gameVisible() {
    const g = document.querySelector('#screen-game');
    return g && !g.hidden;
  }

  // ---------- 動畫元件 ----------

  function spawn(cls, html) {
    const el = document.createElement('div');
    el.className = cls;
    if (html) el.innerHTML = html;
    layer.appendChild(el);
    return el;
  }

  function animate(el, frames, opts) {
    const a = el.animate(frames, { fill: 'forwards', ...opts });
    a.onfinish = () => el.remove();
    return a;
  }

  // 一張牌背從 a 飛到 b
  function flyCard(a, b, { delay = 0, dur = 420, spin = 0, scale = 1 } = {}) {
    if (!a || !b) return;
    const el = spawn('fx-card');
    el.style.left = a.x + 'px';
    el.style.top = a.y + 'px';
    animate(el, [
      { transform: 'translate(-50%,-50%) scale(' + scale + ') rotate(0deg)', opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { transform: 'translate(calc(-50% + ' + (b.x - a.x) + 'px), calc(-50% + ' + (b.y - a.y) + 'px)) scale(' + (scale * 0.7) + ') rotate(' + spin + 'deg)', opacity: 0.9, offset: 0.88 },
      { transform: 'translate(calc(-50% + ' + (b.x - a.x) + 'px), calc(-50% + ' + (b.y - a.y) + 'px)) scale(' + (scale * 0.55) + ') rotate(' + spin + 'deg)', opacity: 0 },
    ], { duration: dur, delay, easing: 'cubic-bezier(.3,.7,.3,1)' });
  }

  // 紅光從 a 射向 b
  function beam(a, b, delay) {
    if (!a || !b) return;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    const el = spawn('fx-beam');
    el.style.left = a.x + 'px';
    el.style.top = a.y + 'px';
    el.style.width = len + 'px';
    el.style.transform = 'rotate(' + ang + 'deg)';
    animate(el, [
      { clipPath: 'inset(0 100% 0 0)', opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', opacity: 1, offset: 0.45 },
      { clipPath: 'inset(0 0 0 0)', opacity: 0 },
    ], { duration: 700, delay: delay || 0, easing: 'ease-out' });
  }

  // 頭像亮起一圈紅光
  function ring(p, { delay = 0, size = 90, dur = 700, color } = {}) {
    if (!p) return;
    const el = spawn('fx-ring');
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.width = el.style.height = size + 'px';
    if (color) el.style.borderColor = color;
    animate(el, [
      { transform: 'translate(-50%,-50%) scale(0.4)', opacity: 1 },
      { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 0 },
    ], { duration: dur, delay, easing: 'ease-out' });
  }

  // 暗紅色的手，從 from 抓一張牌拿回 to
  const HAND_SVG = '<svg viewBox="0 0 64 64"><path d="M14 40c-4-6-6-14-3-15 2-1 4 2 6 6l2 3V12c0-3 4-3 4 0v16-21c0-3 4-3 4 0v21-19c0-3 4-3 4 0v19-15c0-3 4-3 4 0v22c3-5 6-8 8-6 2 2-2 8-6 15-4 8-9 13-17 13-6 0-10-3-16-12z"/></svg>';
  function grab(from, to, delay) {
    if (!from || !to) return;
    const hand = spawn('fx-hand', HAND_SVG);
    hand.style.left = to.x + 'px';
    hand.style.top = to.y + 'px';
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    animate(hand, [
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(1)', opacity: 1, offset: 0.4 },
      { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(.85)', opacity: 1, offset: 0.5 },
      { transform: 'translate(-50%,-50%) scale(.7)', opacity: 0.9, offset: 0.92 },
      { transform: 'translate(-50%,-50%) scale(.5)', opacity: 0 },
    ], { duration: 950, delay: delay || 0, easing: 'ease-in-out' });
    flyCard(from, to, { delay: (delay || 0) + 470, dur: 430, spin: -20, scale: 0.8 });
  }

  // 手牌被撕碎散開
  function shred(p, delay) {
    if (!p) return;
    for (let i = 0; i < 12; i++) {
      const el = spawn('fx-shred');
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      const ang = Math.random() * Math.PI * 2;
      const dist = 70 + Math.random() * 90;
      const rot = (Math.random() - 0.5) * 540;
      animate(el, [
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist + 'px), calc(-50% + ' + (Math.sin(ang) * dist + 40) + 'px)) rotate(' + rot + 'deg)', opacity: 0 },
      ], { duration: 900 + Math.random() * 300, delay: (delay || 0) + 380 + Math.random() * 120, easing: 'cubic-bezier(.2,.6,.4,1)' });
    }
    const slash = spawn('fx-slash');
    slash.style.left = p.x + 'px';
    slash.style.top = p.y + 'px';
    animate(slash, [
      { transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(0)', opacity: 1 },
      { transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(1)', opacity: 1, offset: 0.5 },
      { transform: 'translate(-50%,-50%) rotate(-35deg) scaleX(1)', opacity: 0 },
    ], { duration: 450, delay: delay || 0, easing: 'ease-out' });
  }

  // 爆炸：血花碎片 + 衝擊波
  function explode(p, delay) {
    if (!p) return;
    const d = delay || 0;
    ring(p, { delay: d, size: 160, dur: 650 });
    ring(p, { delay: d + 80, size: 260, dur: 800, color: 'rgba(212,42,58,.5)' });
    const core = spawn('fx-core');
    core.style.left = p.x + 'px';
    core.style.top = p.y + 'px';
    animate(core, [
      { transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 },
      { transform: 'translate(-50%,-50%) scale(1.4)', opacity: 0 },
    ], { duration: 500, delay: d, easing: 'ease-out' });
    for (let i = 0; i < 26; i++) {
      const el = spawn('fx-drop');
      const size = 5 + Math.random() * 11;
      el.style.width = el.style.height = size + 'px';
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 150;
      const fall = 30 + Math.random() * 90;
      animate(el, [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist + 'px), calc(-50% + ' + Math.sin(ang) * dist + 'px)) scale(1)', opacity: 1, offset: 0.55 },
        { transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist * 1.1 + 'px), calc(-50% + ' + (Math.sin(ang) * dist + fall) + 'px)) scale(.6)', opacity: 0 },
      ], { duration: 900 + Math.random() * 500, delay: d, easing: 'cubic-bezier(.15,.7,.4,1)' });
    }
  }

  function flash(delay, strength) {
    const el = spawn('fx-flash');
    animate(el, [{ opacity: 0 }, { opacity: strength || 0.45, offset: 0.15 }, { opacity: 0 }], { duration: 650, delay: delay || 0 });
  }

  function shake(strength, delay) {
    const target = document.querySelector('#screen-game');
    if (!target) return;
    const s = strength || 6;
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const k = 1 - i / 8;
      frames.push({ transform: 'translate(' + ((Math.random() - 0.5) * 2 * s * k).toFixed(1) + 'px,' + ((Math.random() - 0.5) * 2 * s * k).toFixed(1) + 'px)' });
    }
    frames.push({ transform: 'none' });
    target.animate(frames, { duration: 420, delay: delay || 0 });
  }

  function spinRing(delay) {
    for (const el of document.querySelectorAll('#table .ring, #arrows')) {
      el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, delay: delay || 0, easing: 'cubic-bezier(.5,0,.3,1)' });
    }
    const dir = document.querySelector('#center .dir');
    if (dir) dir.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 500, delay: (delay || 0) + 600 });
  }

  // 總數數字快速跳動到新的值
  function tweenTotal(from, to, dur) {
    const start = performance.now();
    const step = (t) => {
      const el = document.querySelector('#total');
      if (!el) return;
      const k = Math.min(1, (t - start) / dur);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function punchTotal(delay) {
    const el = document.querySelector('#total');
    if (el) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 520, delay: delay || 0, easing: 'ease-out' });
  }

  // ---------- 事件 → 特效 ----------

  function handle(events, state) {
    if (!gameVisible() || !state.game) return;
    const motion = !reduce.matches;
    const sec = (ms) => ms / 1000;
    let t = 0; // 這一批事件的時間軸（毫秒）

    for (const e of events) {
      switch (e.type) {
        case 'start': {
          Sound.play('deal');
          if (motion) {
            const deck = deckPoint();
            state.game.players.forEach((p, i) => {
              for (let k = 0; k < 3; k++) flyCard(deck, seatPoint(p.id), { delay: i * 60 + k * 120, dur: 380 });
            });
          }
          t += 600;
          break;
        }
        case 'play': {
          if (e.totalBefore !== e.totalAfter) {
            setTimeout(() => tweenTotal(e.totalBefore, e.totalAfter, e.as === 'K' ? 650 : 320), t);
          }
          if (e.as === 'K' && e.totalBefore !== 99) {
            Sound.play('k99', sec(t));
            if (motion) { flash(t + 200, 0.4); punchTotal(t + 200); shake(4, t + 200); }
            t += 500;
          }
          break;
        }
        case 'reverse':
          Sound.play('reverse', sec(t));
          if (motion) { spinRing(t); shake(3, t + 100); }
          t += 500;
          break;
        case 'designate':
          Sound.play('designate', sec(t));
          if (motion) { beam(seatPoint(e.playerId), seatPoint(e.targetId), t); ring(seatPoint(e.targetId), { delay: t + 300 }); }
          t += 450;
          break;
        case 'steal':
          Sound.play('steal', sec(t + 450));
          if (motion) grab(seatPoint(e.targetId), seatPoint(e.playerId), t);
          t += 800;
          break;
        case 'swap': {
          Sound.play('swap', sec(t));
          if (motion) {
            const a = seatPoint(e.playerId);
            const b = seatPoint(e.targetId);
            for (let k = 0; k < 3; k++) {
              flyCard(a, b, { delay: t + k * 70, dur: 560, spin: 25 });
              flyCard(b, a, { delay: t + k * 70, dur: 560, spin: -25 });
            }
          }
          t += 600;
          break;
        }
        case 'jokerPending':
          if (motion) ring(seatPoint(e.targetId), { delay: t });
          break;
        case 'jokerResolved':
          if (e.discarded > 0) {
            Sound.play('joker', sec(t));
            if (motion) shred(seatPoint(e.targetId), t);
            t += 700;
          }
          break;
        case 'draw':
          Sound.play('draw', sec(t));
          if (motion) flyCard(deckPoint(), seatPoint(e.playerId), { delay: t, dur: 420 });
          t += 150;
          break;
        case 'eliminated':
          Sound.play('explode', sec(t));
          if (motion) { explode(seatPoint(e.playerId), t); shake(12, t); flash(t, 0.3); }
          t += 700;
          break;
        case 'gameOver':
          Sound.play('gameOver', sec(t + 200));
          break;
        default:
          break;
      }
    }
  }

  // ---------- 常駐效果：越接近 99 越紅（只有畫面，沒有心跳聲） ----------

  function update(state) {
    const table = document.querySelector('#table');
    const g = state && state.game;
    const active = !!(g && state.status === 'playing' && gameVisible());
    const heat = active ? Math.max(0, Math.min(1, (g.total - 60) / 39)) : 0;
    if (table) {
      table.style.setProperty('--heat', heat.toFixed(3));
      const intensity = Math.max(0, Math.min(1, (heat - 0.5) / 0.5));
      table.style.setProperty('--beat', Math.round(1150 - intensity * 650) + 'ms');
      table.classList.toggle('hot', heat >= 0.75);
    }
  }

  window.B99Effects = {
    handle,
    update,
    setMuted: (m) => Sound.setMuted(m),
  };
})();

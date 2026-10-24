/* 血腥99 音效：全部用瀏覽器內建的 Web Audio 即時合成，不使用音效檔 */
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let noise = null;
  let muted = false;
  try { muted = !!JSON.parse(localStorage.getItem('b99.muted')); } catch (e) { /* 預設有聲音 */ }

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(comp);
    comp.connect(ctx.destination);
    // 2 秒白噪音，撕裂、爆炸、抽牌都從這裡取材
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  // 瀏覽器規定要使用者先點過畫面，才能播放聲音
  function unlock() {
    if (!init()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));

  function ready() {
    return !muted && ctx && ctx.state === 'running';
  }

  // ---------- 基本元件 ----------

  function gainNode(t, attack, peak, decay, dest) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest || master);
    return g;
  }

  function noiseBurst(t, dur, { type = 'bandpass', freq = 2000, freqEnd, q = 1, peak = 0.3, attack = 0.005 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = gainNode(t, attack, peak, Math.max(0.01, dur - attack));
    src.connect(f);
    f.connect(g);
    src.start(t, Math.random() * 1.5, dur + 0.05);
    return { src, filter: f, gain: g };
  }

  function tone(t, dur, { type = 'sine', freq = 440, freqEnd, peak = 0.3, attack = 0.005 } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = gainNode(t, attack, peak, Math.max(0.01, dur - attack));
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  function thump(t, peak) {
    tone(t, 0.16, { freq: 78, freqEnd: 42, peak, attack: 0.008 });
    noiseBurst(t, 0.05, { type: 'lowpass', freq: 220, peak: peak * 0.35 });
  }

  // ---------- 各種音效 ----------

  const SOUNDS = {
    // 抽牌：輕快的一聲「刷」
    draw(t) {
      noiseBurst(t, 0.09, { type: 'bandpass', freq: 2400, freqEnd: 4200, q: 0.7, peak: 0.9 });
      tone(t + 0.02, 0.04, { type: 'triangle', freq: 1900, peak: 0.06 });
    },

    // A 換牌：兩聲交錯的「唰」
    swap(t) {
      noiseBurst(t, 0.32, { type: 'bandpass', freq: 500, freqEnd: 3200, q: 1.2, peak: 0.95, attack: 0.08 });
      noiseBurst(t + 0.16, 0.32, { type: 'bandpass', freq: 3200, freqEnd: 500, q: 1.2, peak: 0.85, attack: 0.08 });
    },

    // 4 迴轉：低沉的齒輪轉動
    reverse(t) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(64, t);
      o.frequency.linearRampToValueAtTime(46, t + 0.7);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      const g = gainNode(t, 0.04, 0.38, 0.7);
      o.connect(lp); lp.connect(g);
      o.start(t); o.stop(t + 0.8);
      for (let i = 0; i < 11; i++) {
        noiseBurst(t + i * 0.062, 0.018, { type: 'bandpass', freq: 1300 + (i % 2) * 300, q: 3, peak: 0.6 });
      }
    },

    // 5 指定：鎖定的「叮」
    designate(t) {
      tone(t, 0.07, { type: 'square', freq: 660, peak: 0.05 });
      tone(t + 0.06, 0.7, { freq: 1760, peak: 0.2 });
      tone(t + 0.06, 0.5, { freq: 2640, peak: 0.06 });
    },

    // 7 偷牌：抓取聲
    steal(t) {
      noiseBurst(t, 0.14, { type: 'lowpass', freq: 1600, freqEnd: 500, peak: 0.7, attack: 0.01 });
      tone(t + 0.03, 0.18, { freq: 160, freqEnd: 70, peak: 0.4 });
      noiseBurst(t + 0.2, 0.06, { type: 'bandpass', freq: 2400, q: 1, peak: 0.45 });
    },

    // K 變 99：心跳加重低音
    k99(t) {
      thump(t, 0.7);
      thump(t + 0.2, 0.5);
      tone(t + 0.02, 0.9, { freq: 48, freqEnd: 34, peak: 0.45, attack: 0.02 });
      noiseBurst(t, 0.6, { type: 'lowpass', freq: 400, freqEnd: 90, peak: 0.18, attack: 0.02 });
    },

    // 鬼牌：撕裂聲 → 紙牌散落的「啪啦啦」→ 下沉的低音
    joker(t) {
      const tear = noiseBurst(t, 0.42, { type: 'bandpass', freq: 1400, freqEnd: 3800, q: 0.9, peak: 0.34, attack: 0.02 });
      // 讓撕裂聲斷斷續續、毛毛的
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 34;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth);
      depth.connect(tear.gain.gain);
      lfo.start(t); lfo.stop(t + 0.45);
      for (let i = 0; i < 16; i++) {
        const at = t + 0.44 + Math.random() * 0.38;
        noiseBurst(at, 0.012 + Math.random() * 0.012, { type: 'bandpass', freq: 1800 + Math.random() * 2200, q: 3, peak: 0.12 + Math.random() * 0.15 });
      }
      tone(t + 0.86, 0.75, { type: 'triangle', freq: 220, freqEnd: 52, peak: 0.3, attack: 0.02 });
    },

    // 爆炸出局
    explode(t) {
      noiseBurst(t, 0.06, { type: 'highpass', freq: 1800, peak: 0.5, attack: 0.002 });
      noiseBurst(t, 1.3, { type: 'lowpass', freq: 1100, freqEnd: 120, peak: 0.75, attack: 0.008 });
      tone(t, 0.9, { freq: 95, freqEnd: 28, peak: 0.7, attack: 0.005 });
      for (let i = 0; i < 8; i++) {
        noiseBurst(t + 0.15 + Math.random() * 0.6, 0.03, { type: 'bandpass', freq: 600 + Math.random() * 1200, q: 2, peak: 0.08 });
      }
    },

    // 發牌
    deal(t) {
      for (let i = 0; i < 6; i++) SOUNDS.draw(t + i * 0.07);
    },

    // 遊戲結束
    gameOver(t) {
      tone(t, 1.6, { type: 'triangle', freq: 110, freqEnd: 55, peak: 0.3, attack: 0.05 });
      tone(t + 0.1, 1.4, { type: 'sine', freq: 165, freqEnd: 82, peak: 0.15, attack: 0.05 });
    },
  };

  window.B99Sound = {
    play(name, delaySec, arg) {
      if (!ready() || !SOUNDS[name]) return;
      try { SOUNDS[name](ctx.currentTime + 0.01 + (delaySec || 0), arg); } catch (e) { console.error(e); }
    },
    setMuted(m) {
      muted = !!m;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.02);
    },
    get muted() { return muted; },
    unlock,
    // 開發檢查用：把某個音效離線算出來，回傳最大音量與平均音量
    async measure(name, seconds, arg) {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const saved = [ctx, master, noise];
      const off = new AC(1, Math.ceil(44100 * (seconds || 2)), 44100);
      ctx = off;
      master = off.createGain();
      master.gain.value = 0.7;
      const comp = off.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      master.connect(comp); comp.connect(off.destination);
      noise = off.createBuffer(1, 44100 * 2, 44100);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      SOUNDS[name](0.01, arg);
      [ctx, master, noise] = saved;
      const buf = await off.startRendering();
      const data = buf.getChannelData(0);
      let peak = 0; let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; sum += v * v; }
      return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / data.length).toFixed(4) };
    },
  };
})();

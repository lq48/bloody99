'use strict';

// 牌的基本定義：兩副撲克牌 + 兩張鬼牌，共 106 張。

const SUITS = ['S', 'H', 'D', 'C']; // 黑桃、紅心、方塊、梅花
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// 組合出牌時使用的點數
const RANK_VALUE = {
  A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13,
};

// 普通數字牌：單張打出時把點數加到總數
const NUMBER_RANKS = new Set(['2', '3', '6', '8', '9']);

// 需要指定目標玩家的牌
const TARGET_RANKS = new Set(['A', '5', '7', 'JOKER']);

// 使用後不抽牌的牌
const NO_DRAW_RANKS = new Set(['A', '7']);

function createDeck({ decks = 2, jokers = 2 } = {}) {
  const cards = [];
  let n = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: 'c' + n++, rank, suit });
      }
    }
  }
  for (let j = 0; j < jokers; j++) {
    cards.push({ id: 'c' + n++, rank: 'JOKER', suit: null });
  }
  return cards;
}

function rankFromValue(value) {
  return RANKS[value - 1];
}

// 可設定種子的亂數產生器，方便測試重現同一局
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  SUITS, RANKS, RANK_VALUE, NUMBER_RANKS, TARGET_RANKS, NO_DRAW_RANKS,
  createDeck, rankFromValue, mulberry32, shuffle,
};

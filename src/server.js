'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

/**
 * 啟動遊戲伺服器。
 * 網頁檔案放在 public/ 資料夾，玩家打開網址就會拿到；遊戲資料透過 Socket.IO 即時傳送。
 */
function startServer({ port = Number(process.env.PORT) || 3000, ...managerOptions } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024, // 玩家送來的資料都很小，限制大小避免濫用
  });

  const manager = new RoomManager({
    send: (socketId, event, payload) => io.to(socketId).emit(event, payload),
    ...managerOptions,
  });

  io.on('connection', (socket) => {
    // 每個動作都用 ack 回覆結果：{ ok: true, ... } 或 { ok: false, code, message }
    const handle = (eventName, fn) => {
      socket.on(eventName, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const result = fn(payload && typeof payload === 'object' ? payload : {});
          reply({ ok: true, ...(result || {}) });
        } catch (err) {
          if (err && err.code) {
            reply({ ok: false, code: err.code, message: err.message });
          } else {
            console.error('[server error]', eventName, err);
            reply({ ok: false, code: 'SERVER', message: '伺服器發生錯誤，請重新整理頁面' });
          }
        }
      });
    };

    handle('createRoom', (p) => manager.createRoom(socket.id, p));
    handle('joinRoom', (p) => manager.joinRoom(socket.id, p));
    handle('resume', (p) => manager.resume(socket.id, p));
    handle('leaveRoom', () => manager.leaveRoom(socket.id));
    handle('setSettings', (p) => manager.setSettings(socket.id, p));
    handle('pickTeam', (p) => manager.pickTeam(socket.id, p));
    handle('startGame', () => manager.startGame(socket.id));
    handle('action', (p) => manager.action(socket.id, p));
    handle('backToLobby', () => manager.backToLobby(socket.id));
    handle('chat', (p) => manager.chat(socket.id, p));

    socket.on('disconnect', () => {
      try {
        manager.disconnect(socket.id);
      } catch (err) {
        console.error('[disconnect error]', err);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        manager,
        io,
        close: () => new Promise((done) => { manager.shutdown(); io.close(); server.close(() => done()); }),
      });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log('血腥99 伺服器已啟動：http://localhost:' + port);
  });
}

module.exports = { startServer };

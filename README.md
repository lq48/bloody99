# 血腥99

線上多人撲克牌遊戲。從 99 開始，誰爆誰死。

## 上線（Render）

- Build Command：`npm install`
- Start Command：`npm start`
- 方案：Free
- 健康檢查路徑（選填）：`/healthz`

完整的一步步教學請看「血腥99 上線教學」文件。

## 本機執行（選用）

需要 Node.js 22：

```
npm install
npm start
```

打開 http://localhost:3000

## 測試

```
npm test
```

## 資料夾

- `src/engine.js` 規則引擎
- `src/rooms.js` 房間、斷線重連、計時
- `src/server.js` 網頁與即時連線伺服器
- `public/` 遊戲畫面、特效、音效
- `test/` 自動測試

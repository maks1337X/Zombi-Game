const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomId => { players: Map, gameState: {} }

app.use(express.static('.')); // отдаёт все файлы (index.html, script.js и т.д.)

wss.on('connection', (ws) => {
  console.log('Новый игрок подключился');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Здесь будет логика комнат, синхронизации и т.д.
      // Пока просто эхо + broadcast
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch(e) {}
  });

  ws.on('close', () => console.log('Игрок отключился'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
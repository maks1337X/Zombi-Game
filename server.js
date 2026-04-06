const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище комнат
const rooms = new Map(); // roomId => { players: Map<id, ws>, hostId: number }

app.use(express.static('.')); // отдаёт index.html, script.js и т.д.

wss.on('connection', (ws) => {
  console.log('Новый игрок подключился');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        const roomId = data.roomId;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, { players: new Map(), hostId: data.id });
        }

        const room = rooms.get(roomId);
        room.players.set(data.id, ws);

        console.log(`Игрок ${data.id} присоединился к комнате ${roomId}`);

        // Отправляем всем в комнате сообщение о новом игроке
        const joinMsg = JSON.stringify({
          type: 'join',
          id: data.id,
          name: data.name,
          costume: data.costume
        });

        room.players.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(joinMsg);
          }
        });

        // Если в комнате 2 игрока — запускаем игру
        if (room.players.size >= 2) {
          console.log(`Комната ${roomId} готова. Запускаем игру...`);
          const startMsg = JSON.stringify({ type: 'startGame' });
          room.players.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(startMsg);
            }
          });
        }
      }

      // Пересылаем остальные сообщения всем в комнате
      else if (data.roomId) {
        const room = rooms.get(data.roomId);
        if (room) {
          const broadcastMsg = JSON.stringify(data);
          room.players.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(broadcastMsg);
            }
          });
        }
      }
    } catch (e) {
      console.error("Ошибка обработки сообщения:", e);
    }
  });

  ws.on('close', () => {
    console.log('Игрок отключился');
    // Можно добавить очистку комнат при отключении, но пока пропустим
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
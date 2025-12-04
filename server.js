const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Хранилище данных в памяти
const registeredNumbers = ['+375000', '+375001'];
const VERIFY_CODE = '11111';
const sessions = new Map(); // phoneNumber -> sessionId
const messages = []; // История сообщений
const clients = new Map(); // sessionId -> WebSocket

// WebSocket обработка
wss.on('connection', (ws) => {
  console.log('Новое WebSocket подключение');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Регистрация клиента
      if (message.type === 'register') {
        const userPhone = Array.from(sessions.entries())
          .find(([phone, sid]) => sid === message.sessionId)?.[0];
        
        if (userPhone) {
          clients.set(message.sessionId, ws);
          ws.sessionId = message.sessionId;
          ws.phoneNumber = userPhone;
          console.log(`Пользователь ${userPhone} подключен через WebSocket`);
        }
      }
      
      // Отправка сообщения
      if (message.type === 'sendMessage') {
        const userPhone = Array.from(sessions.entries())
          .find(([phone, sid]) => sid === message.sessionId)?.[0];
        
        if (!userPhone) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Не авторизован' 
          }));
          return;
        }
        
        const newMessage = {
          id: `msg_${Date.now()}_${Math.random()}`,
          from: userPhone,
          to: message.to,
          text: message.text,
          timestamp: new Date().toISOString()
        };
        
        // Сохраняем сообщение
        messages.push(newMessage);
        
        // Отправляем отправителю
        ws.send(JSON.stringify({ 
          type: 'messageSent', 
          message: newMessage 
        }));
        
        // Находим получателя
        const recipientSession = sessions.get(message.to);
        if (recipientSession) {
          const recipientWs = clients.get(recipientSession);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({ 
              type: 'newMessage', 
              message: newMessage 
            }));
          }
        }
        
        console.log(`Сообщение от ${userPhone} к ${message.to}: ${message.text}`);
      }
    } catch (err) {
      console.error('Ошибка обработки WebSocket сообщения:', err);
    }
  });
  
  ws.on('close', () => {
    if (ws.sessionId) {
      clients.delete(ws.sessionId);
      console.log(`Пользователь ${ws.phoneNumber} отключен`);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket ошибка:', error);
  });
});

// Endpoint для проверки номера телефона
app.post('/api/auth/check-phone', (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Номер телефона обязателен' });
  }
  
  const isRegistered = registeredNumbers.includes(phoneNumber);
  
  res.json({ 
    registered: isRegistered,
    message: isRegistered ? 'Номер найден' : 'Номер не зарегистрирован'
  });
});

// Endpoint для верификации кода
app.post('/api/auth/verify-code', (req, res) => {
  const { phoneNumber, code } = req.body;
  
  if (!phoneNumber || !code) {
    return res.status(400).json({ error: 'Номер и код обязательны' });
  }
  
  if (!registeredNumbers.includes(phoneNumber)) {
    return res.status(404).json({ error: 'Номер не найден' });
  }
  
  if (code !== VERIFY_CODE) {
    return res.status(401).json({ error: 'Неверный код' });
  }
  
  // Создаем сессию
  const sessionId = `session_${phoneNumber}_${Date.now()}`;
  sessions.set(phoneNumber, sessionId);
  
  res.json({ 
    success: true,
    sessionId,
    phoneNumber,
    message: 'Вход выполнен успешно'
  });
});

// Endpoint для получения списка чатов
app.get('/api/chats', (req, res) => {
  const { sessionId } = req.query;
  
  if (!sessionId) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  
  // Находим номер пользователя по сессии
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  if (!userPhone) {
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  // Возвращаем список других пользователей
  const chats = registeredNumbers
    .filter(phone => phone !== userPhone)
    .map(phone => ({
      phoneNumber: phone,
      lastMessage: getLastMessage(userPhone, phone),
      unreadCount: 0
    }));
  
  res.json({ chats });
});

// Endpoint для получения истории сообщений
app.get('/api/messages', (req, res) => {
  const { sessionId, withPhone } = req.query;
  
  if (!sessionId || !withPhone) {
    return res.status(400).json({ error: 'Параметры не переданы' });
  }
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  if (!userPhone) {
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  // Фильтруем сообщения между двумя пользователями
  const chatMessages = messages.filter(msg => 
    (msg.from === userPhone && msg.to === withPhone) ||
    (msg.from === withPhone && msg.to === userPhone)
  );
  
  res.json({ messages: chatMessages });
});

// Функция для получения последнего сообщения
function getLastMessage(userPhone, otherPhone) {
  const chatMessages = messages.filter(msg => 
    (msg.from === userPhone && msg.to === otherPhone) ||
    (msg.from === otherPhone && msg.to === userPhone)
  );
  
  if (chatMessages.length === 0) return null;
  
  const lastMsg = chatMessages[chatMessages.length - 1];
  return {
    text: lastMsg.text,
    timestamp: lastMsg.timestamp,
    isOwn: lastMsg.from === userPhone
  };
}

// Health check endpoint для Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Messenger API',
    version: '1.0.0',
    endpoints: [
      'POST /api/auth/check-phone',
      'POST /api/auth/verify-code',
      'GET /api/chats',
      'GET /api/messages',
      'GET /health'
    ]
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📱 Зарегистрированные номера: ${registeredNumbers.join(', ')}`);
  console.log(`🔑 Код верификации: ${VERIFY_CODE}`);
  console.log(`🌐 WebSocket сервер готов к подключениям`);
});

// Экспорт для тестирования
module.exports = { app, server };
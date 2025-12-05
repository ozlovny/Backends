const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS для любого origin (для продакшена измени на конкретный домен)
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json());

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Пути к JSON файлам
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// Создаём папку data если её нет
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Загрузка/сохранение данных
function loadJSON(file, defaultData = []) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`Ошибка загрузки ${file}:`, err);
  }
  return defaultData;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Ошибка сохранения ${file}:`, err);
  }
}

// Загружаем данные
let users = loadJSON(USERS_FILE, [
  { phoneNumber: '+375000', username: null, registeredAt: new Date().toISOString() },
  { phoneNumber: '+375001', username: null, registeredAt: new Date().toISOString() }
]);
let messages = loadJSON(MESSAGES_FILE, []);
const sessions = new Map();
const activeCodes = new Map(); // phoneNumber -> code
const clients = new Map();

// Сохраняем users при изменении
function saveUsers() {
  saveJSON(USERS_FILE, users);
}

// Генерация случайного кода
function generateCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// WebSocket обработка
wss.on('connection', (ws) => {
  console.log('Новое WebSocket подключение');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
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
      
      if (message.type === 'sendMessage') {
        const userPhone = Array.from(sessions.entries())
          .find(([phone, sid]) => sid === message.sessionId)?.[0];
        
        if (!userPhone) {
          ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
          return;
        }
        
        // Проверяем существует ли получатель, если нет - создаём
        let recipient = users.find(u => u.phoneNumber === message.to);
        if (!recipient) {
          recipient = {
            phoneNumber: message.to,
            username: null,
            registeredAt: new Date().toISOString()
          };
          users.push(recipient);
          saveUsers();
          console.log(`✨ Создан новый пользователь через сообщение: ${message.to}`);
        }
        
        const newMessage = {
          id: `msg_${Date.now()}_${Math.random()}`,
          from: userPhone,
          to: message.to,
          text: message.text,
          timestamp: new Date().toISOString()
        };
        
        messages.push(newMessage);
        saveJSON(MESSAGES_FILE, messages);
        
        ws.send(JSON.stringify({ type: 'messageSent', message: newMessage }));
        
        const recipientSession = sessions.get(message.to);
        if (recipientSession) {
          const recipientWs = clients.get(recipientSession);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({ type: 'newMessage', message: newMessage }));
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
});

// Проверка номера и генерация кода
app.post('/api/auth/check-phone', (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Номер телефона обязателен' });
  }
  
  // Ищем существующего пользователя
  let user = users.find(u => u.phoneNumber === phoneNumber);
  
  // Если пользователя нет - создаём нового
  if (!user) {
    user = {
      phoneNumber: phoneNumber,
      username: null,
      registeredAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers();
    console.log(`✨ Создан новый пользователь: ${phoneNumber}`);
  }
  
  const code = generateCode();
  activeCodes.set(phoneNumber, code);
  
  console.log(`\n==========================================`);
  console.log(`📱 ВХОД В АККАУНТ: ${phoneNumber}`);
  console.log(`🔑 КОД ДОСТУПА: ${code}`);
  console.log(`==========================================\n`);
  
  // Удаляем код через 5 минут
  setTimeout(() => {
    activeCodes.delete(phoneNumber);
  }, 5 * 60 * 1000);
  
  res.json({ 
    registered: true, 
    isNew: !user.username,
    message: 'Код отправлен в консоль сервера' 
  });
});

// Верификация кода
app.post('/api/auth/verify-code', (req, res) => {
  const { phoneNumber, code } = req.body;
  
  console.log('Verify code request:', { phoneNumber, code });
  
  if (!phoneNumber || !code) {
    return res.status(400).json({ error: 'Номер и код обязательны' });
  }
  
  const user = users.find(u => u.phoneNumber === phoneNumber);
  
  if (!user) {
    return res.status(404).json({ error: 'Номер не найден' });
  }
  
  const validCode = activeCodes.get(phoneNumber);
  console.log('Valid code for', phoneNumber, ':', validCode);
  
  if (code !== validCode) {
    return res.status(401).json({ error: 'Неверный код' });
  }
  
  activeCodes.delete(phoneNumber);
  
  const sessionId = `session_${phoneNumber}_${Date.now()}`;
  sessions.set(phoneNumber, sessionId);
  
  console.log('✅ Session created:', sessionId);
  console.log('📋 Active sessions:', Array.from(sessions.entries()));
  
  res.json({ 
    success: true,
    sessionId,
    phoneNumber,
    username: user.username,
    message: 'Вход выполнен успешно'
  });
});

// Установка юзернейма (только один раз)
app.post('/api/auth/set-username', (req, res) => {
  console.log('Set username request:', req.body);
  
  const { sessionId, username } = req.body;
  
  if (!sessionId || !username) {
    return res.status(400).json({ error: 'SessionId и username обязательны' });
  }
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  if (!userPhone) {
    console.log('Session not found:', sessionId);
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  const user = users.find(u => u.phoneNumber === userPhone);
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  if (user.username) {
    return res.status(400).json({ error: 'Юзернейм уже установлен' });
  }
  
  // Проверка на уникальность
  const usernameExists = users.some(u => u.username && u.username.toLowerCase() === username.toLowerCase());
  
  if (usernameExists) {
    return res.status(400).json({ error: 'Этот юзернейм уже занят' });
  }
  
  user.username = username;
  saveUsers();
  
  console.log('Username set successfully:', username);
  res.json({ success: true, username });
});

// Получить список всех пользователей
app.get('/api/users', (req, res) => {
  const { sessionId } = req.query;
  
  console.log('GET /api/users - sessionId:', sessionId);
  
  if (!sessionId) {
    console.log('❌ No sessionId provided');
    return res.status(401).json({ error: 'Не авторизован' });
  }
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  console.log('Found user phone:', userPhone);
  console.log('Active sessions:', Array.from(sessions.entries()));
  
  if (!userPhone) {
    console.log('❌ Session not found in active sessions');
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  const usersList = users
    .filter(u => u.phoneNumber !== userPhone)
    .map(u => ({
      phoneNumber: u.phoneNumber,
      username: u.username,
      lastMessage: getLastMessage(userPhone, u.phoneNumber)
    }));
  
  console.log(`✅ Returning ${usersList.length} users`);
  res.json({ users: usersList });
});

// Поиск пользователей (включая поиск по несуществующим номерам)
app.get('/api/users/search', (req, res) => {
  const { sessionId, query } = req.query;
  
  console.log('GET /api/users/search - sessionId:', sessionId, 'query:', query);
  
  if (!sessionId) {
    console.log('❌ No sessionId provided');
    return res.status(401).json({ error: 'Не авторизован' });
  }
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  console.log('Search - Found user phone:', userPhone);
  
  if (!userPhone) {
    console.log('❌ Session not found in active sessions');
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  const searchQuery = (query || '').toLowerCase().trim();
  console.log('Processing search query:', searchQuery);
  
  // Поиск среди существующих пользователей
  let results = users
    .filter(u => u.phoneNumber !== userPhone)
    .filter(u => {
      const phoneMatch = u.phoneNumber.toLowerCase().includes(searchQuery);
      const usernameMatch = u.username && u.username.toLowerCase().includes(searchQuery);
      return phoneMatch || usernameMatch;
    })
    .map(u => ({
      phoneNumber: u.phoneNumber,
      username: u.username,
      exists: true,
      lastMessage: getLastMessage(userPhone, u.phoneNumber)
    }));
  
  console.log(`Found ${results.length} existing users`);
  
  // Если запрос похож на номер телефона и не найден в базе - добавляем как новый
  const isPhoneNumberQuery = /^[\+\d\s\-\(\)]+$/.test(searchQuery);
  
  if (isPhoneNumberQuery && searchQuery.length >= 5) {
    const cleanQuery = searchQuery.replace(/[\s\-\(\)]/g, '');
    const existsInResults = results.some(r => r.phoneNumber.includes(cleanQuery));
    
    console.log('Is phone query:', isPhoneNumberQuery, 'Clean:', cleanQuery, 'Exists:', existsInResults);
    
    if (!existsInResults && cleanQuery !== userPhone.replace(/[\s\-\(\)]/g, '')) {
      console.log('Adding as new contact:', searchQuery);
      // Добавляем как потенциальный новый контакт
      results.unshift({
        phoneNumber: searchQuery,
        username: null,
        exists: false,
        isNewContact: true,
        lastMessage: null
      });
    }
  }
  
  console.log(`✅ Returning ${results.length} search results`);
  res.json({ users: results });
});

// Получить список чатов
app.get('/api/chats', (req, res) => {
  const { sessionId } = req.query;
  
  if (!sessionId) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  if (!userPhone) {
    return res.status(401).json({ error: 'Сессия не найдена' });
  }
  
  // Получаем пользователей с которыми есть переписка
  const chatPartners = new Set();
  messages.forEach(msg => {
    if (msg.from === userPhone) chatPartners.add(msg.to);
    if (msg.to === userPhone) chatPartners.add(msg.from);
  });
  
  const chats = Array.from(chatPartners).map(phone => {
    const user = users.find(u => u.phoneNumber === phone);
    return {
      phoneNumber: phone,
      username: user?.username,
      lastMessage: getLastMessage(userPhone, phone),
      unreadCount: 0
    };
  });
  
  res.json({ chats });
});

// Получить историю сообщений
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
  
  const chatMessages = messages.filter(msg => 
    (msg.from === userPhone && msg.to === withPhone) ||
    (msg.from === withPhone && msg.to === userPhone)
  );
  
  res.json({ messages: chatMessages });
});

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint - проверка сессии
app.get('/api/debug/session', (req, res) => {
  const { sessionId } = req.query;
  
  const userPhone = Array.from(sessions.entries())
    .find(([phone, sid]) => sid === sessionId)?.[0];
  
  res.json({
    sessionId,
    valid: !!userPhone,
    userPhone: userPhone || null,
    totalSessions: sessions.size,
    allSessions: Array.from(sessions.entries()).map(([phone, sid]) => ({ 
      phone, 
      sessionId: sid,
      matches: sid === sessionId 
    }))
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'Messenger API v2.1',
    version: '2.1.0',
    endpoints: [
      'POST /api/auth/check-phone',
      'POST /api/auth/verify-code',
      'POST /api/auth/set-username',
      'GET /api/users',
      'GET /api/users/search',
      'GET /api/chats',
      'GET /api/messages',
      'GET /api/debug/session',
      'GET /health'
    ]
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📱 Зарегистрировано пользователей: ${users.length}`);
  console.log(`💬 Сообщений в базе: ${messages.length}`);
  console.log(`🌐 WebSocket сервер готов к подключениям`);
});

module.exports = { app, server };

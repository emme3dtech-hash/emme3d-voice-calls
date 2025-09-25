const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('EMME3D Voice AI система запускается...');

// Конфигурация
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://emme3d-voice-calls-production.up.railway.app';

// Zadarma данные
const ZADARMA_SIP_USER = process.env.ZADARMA_SIP_USER;
const CALLER_ID = process.env.CALLER_ID || '+380914811639';

// Инициализация сервисов
const client = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// Хранение активных разговоров
const activeConversations = new Map();

// === НОРМАЛИЗАЦИЯ НОМЕРА ТЕЛЕФОНА ===
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  
  let cleaned = phoneNumber.replace(/[^0-9]/g, '');
  console.log(`Шаг 1 - убрали символы: "${phoneNumber}" → "${cleaned}"`);
  
  if (cleaned.startsWith('380380')) {
    cleaned = cleaned.substring(3);
    console.log(`Шаг 2 - убрали дублирование: → "${cleaned}"`);
  }
  
  if (cleaned.startsWith('380')) {
    cleaned = cleaned.substring(3);
    console.log(`Шаг 3 - убрали код страны: → "${cleaned}"`);
  }
  
  if (cleaned.length !== 9) {
    console.log(`❌ Некорректная длина номера: ${cleaned.length} цифр`);
    return '';
  }
  
  console.log(`✅ Финальный номер для Zadarma: "${cleaned}"`);
  return cleaned;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'EMME3D Voice AI System',
    timestamp: new Date().toISOString(),
    config: {
      twilio_configured: !!TWILIO_ACCOUNT_SID,
      zadarma_configured: !!ZADARMA_SIP_USER,
      base_url: BASE_URL
    }
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'Система готова к работе!',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /health',
      'GET /test', 
      'POST /api/make-ai-call',
      'POST /handle-outbound-call',
      'POST /process-customer-response'
    ]
  });
});

// === ОСНОВНАЯ ФУНКЦИЯ AI ЗВОНКА ===
app.post('/api/make-ai-call', async (req, res) => {
  console.log('🔥 Получен запрос на AI звонок');
  console.log('Body:', req.body);
  
  try {
    const { phone_number, customer_name } = req.body;
    
    if (!phone_number) {
      return res.status(400).json({ 
        error: 'phone_number обязателен',
        received_body: req.body 
      });
    }

    if (!client) {
      return res.status(500).json({ 
        error: 'Twilio не настроен. Добавьте TWILIO_ACCOUNT_SID и TWILIO_AUTH_TOKEN'
      });
    }

    console.log(`📞 Инициируем AI звонок на ${phone_number}`);
    
    const cleanNumber = normalizePhoneNumber(phone_number);
    
    if (!cleanNumber) {
      return res.status(400).json({ 
        error: 'Некорректный номер телефона',
        received_number: phone_number 
      });
    }

    console.log(`🎯 Отправляем звонок на: sip:${cleanNumber}@pbx.zadarma.com`);
    
    const call = await client.calls.create({
      to: `sip:${cleanNumber}@pbx.zadarma.com`,
      from: '+380914811639',
      sipAuthUsername: process.env.ZADARMA_SIP_USER,
      sipAuthPassword: process.env.ZADARMA_SIP_PASSWORD,
      url: `${BASE_URL}/handle-outbound-call?phone=${encodeURIComponent(phone_number)}&name=${encodeURIComponent(customer_name || '')}`,
      statusCallback: `${BASE_URL}/call-status`,
      record: true
    });

    console.log('✅ Звонок создан:', call.sid);

    res.json({
      success: true,
      call_sid: call.sid,
      message: `AI звонок инициирован на ${phone_number}`,
      customer_name: customer_name,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Ошибка создания AI звонка:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// === ГЕНЕРАЦИЯ ПРИВЕТСТВИЯ ===
function generateGreeting(customerName) {
  const greetings = [
    `Привіт${customerName ? `, ${customerName}` : ''}! Це Олена з компанії EMME3D. Ми друкуємо рідкісні автозапчастини на 3D принтері. У вас є хвилинка?`,
    `Доброго дня${customerName ? `, ${customerName}` : ''}! Дзвоню з EMME3D. Ми допомагаємо автовласникам знаходити рідкісні запчастини через 3D друк. Можу розказати більше?`
  ];
  
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// === ОБРАБОТКА ИСХОДЯЩЕГО ЗВОНКА ===
app.post('/handle-outbound-call', (req, res) => {
  const callSid = req.body.CallSid;
  const customerPhone = req.query.phone;
  const customerName = req.query.name;

  console.log(`📞 Обрабатываем исходящий звонок ${callSid} на ${customerPhone}`);

  // Создаем контекст разговора
  activeConversations.set(callSid, {
    phone: customerPhone,
    name: customerName,
    messages: [],
    startTime: new Date(),
    stage: 'greeting'
  });

  const twiml = new twilio.twiml.VoiceResponse();

  // Приветственное сообщение
  const greeting = generateGreeting(customerName);
  twiml.say({
    voice: 'Polly.Joanna',
    language: 'uk-UA',
    rate: '0.85'
  }, greeting);

  // Ожидаем ответа клиента
  const gather = twiml.gather({
    speechTimeout: 'auto',
    timeout: 12,
    speechModel: 'experimental_conversations',
    language: 'uk-UA', 
    enhanced: true,
    action: '/process-customer-response',
    method: 'POST'
  });

  // Если клиент молчит
  twiml.say({
    voice: 'Polly.Joanna',
    language: 'uk-UA'
  }, 'Дякую за увагу! Гарного дня!');
  
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// === ПРОСТАЯ ГЕНЕРАЦИЯ ОТВЕТА ===
function generateSimpleResponse(userInput, conversation) {
  const input = userInput.toLowerCase();
  
  // Определяем интент клиента
  if (input.includes('не цікав') || input.includes('не треба') || input.includes('не хочу') || input.includes('зайнят')) {
    conversation.stage = 'rejection';
    return 'Зрозуміло! Дякую за час. Гарного дня!';
  }
  
  if (input.includes('цікав') || input.includes('так') || input.includes('розкажіть')) {
    conversation.stage = 'interested';
    return 'Чудово! Ми друкуємо запчастини за 1-3 дні. Яка у вас машина?';
  }
  
  if (input.includes('bmw') || input.includes('бмв') || input.includes('audi') || input.includes('ауді') || 
      input.includes('mercedes') || input.includes('мерседес')) {
    conversation.stage = 'discussing_needs';
    return 'Відмінно! З цією маркою працюємо часто. Які саме запчастини потрібні?';
  }
  
  if (input.includes('запчасти') || input.includes('деталь') || input.includes('частина')) {
    return 'Ми можемо зробити майже будь-яку деталь за фото або кресленням. Зателефонуйте нам на +380914811639';
  }
  
  if (input.includes('ціна') || input.includes('скільки') || input.includes('вартість')) {
    return 'Ціна залежить від складності. Зазвичай від 200 до 2000 гривень. Деталі обговоримо по телефону.';
  }
  
  if (input.includes('пізніше') || input.includes('подумаю')) {
    conversation.stage = 'maybe_later';
    return 'Звичайно! Наш номер +380914811639. Будемо раді допомогти!';
  }
  
  // Дефолтный ответ
  return 'Розумію. Ми допомагаємо з 3D друком автозапчастин. Можете зателефонувати нам +380914811639';
}

// === ОБРАБОТКА ОТВЕТА КЛИЕНТА ===
app.post('/process-customer-response', (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = req.body.Confidence;

  console.log(`🎤 Клиент сказал: "${speechResult}" (уверенность: ${confidence})`);

  const conversation = activeConversations.get(callSid);
  if (!conversation) {
    console.log('❌ Разговор не найден:', callSid);
    return res.status(404).send('Разговор не найден');
  }

  const twiml = new twilio.twiml.VoiceResponse();

  // Если речь не распознана четко
  if (!speechResult || confidence < 0.4) {
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Вибачте, я не зрозуміла. Можете повторити?');

    const gather = twiml.gather({
      speechTimeout: 'auto',
      timeout: 10,
      action: '/process-customer-response'
    });

    return res.type('text/xml').send(twiml.toString());
  }

  // Добавляем сообщение клиента в контекст
  conversation.messages.push({ 
    role: 'user', 
    content: speechResult,
    timestamp: new Date()
  });

  // Генерируем простой ответ
  const aiResponse = generateSimpleResponse(speechResult, conversation);
  
  conversation.messages.push({ 
    role: 'assistant', 
    content: aiResponse,
    timestamp: new Date()
  });

  // Проигрываем ответ
  twiml.say({
    voice: 'Polly.Joanna',
    language: 'uk-UA',
    rate: '0.85'
  }, aiResponse);

  // Определяем следующее действие
  if (shouldEndCall(aiResponse, conversation)) {
    twiml.hangup();
    
    // Сохраняем результат звонка
    saveCallResult(conversation);
    activeConversations.delete(callSid);
    
  } else {
    // Продолжаем разговор
    const gather = twiml.gather({
      speechTimeout: 'auto',
      timeout: 15,
      action: '/process-customer-response',
      speechModel: 'experimental_conversations',
      language: 'uk-UA'
    });

    twiml.say('Дякую за увагу! До побачення!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// === ОПРЕДЕЛЕНИЕ ЗАВЕРШЕНИЯ ЗВОНКА ===
function shouldEndCall(aiResponse, conversation) {
  const response = aiResponse.toLowerCase();
  const maxDuration = 3 * 60 * 1000; // 3 минуты максимум
  const currentDuration = new Date() - conversation.startTime;
  
  return (
    response.includes('до побачення') ||
    response.includes('гарного дня') ||
    response.includes('дякую за час') ||
    conversation.stage === 'rejection' ||
    conversation.messages.length > 8 ||
    currentDuration > maxDuration
  );
}

// === СОХРАНЕНИЕ РЕЗУЛЬТАТА ЗВОНКА ===
function saveCallResult(conversation) {
  try {
    const result = {
      phone: conversation.phone,
      name: conversation.name,
      duration: Math.round((new Date() - conversation.startTime) / 1000),
      messages_count: conversation.messages.length,
      stage: conversation.stage,
      completed_at: new Date().toISOString()
    };

    console.log('📊 Результат звонка:', result);
    
  } catch (error) {
    console.error('❌ Ошибка сохранения результата:', error);
  }
}

// === СТАТУС ЗВОНКОВ ===
app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  console.log(`📊 Звонок ${callSid}: статус ${callStatus}`);
  
  if (callStatus === 'completed' || callStatus === 'failed') {
    const conversation = activeConversations.get(callSid);
    if (conversation) {
      saveCallResult(conversation);
      activeConversations.delete(callSid);
    }
  }
  
  res.status(200).send('OK');
});

// === СТАТИСТИКА АКТИВНЫХ ЗВОНКОВ ===
app.get('/api/active-calls', (req, res) => {
  const calls = Array.from(activeConversations.entries()).map(([callSid, conv]) => ({
    call_sid: callSid,
    phone: conv.phone,
    name: conv.name,
    stage: conv.stage,
    duration: Math.round((new Date() - conv.startTime) / 1000),
    messages_count: conv.messages.length
  }));

  res.json({
    active_calls: calls.length,
    calls: calls
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 EMME3D Voice AI система запущена на порту ${PORT}`);
  console.log('📞 Основные эндпоинты:');
  console.log('  POST /api/make-ai-call - AI звонок');  
  console.log('  GET /api/active-calls - Активные звонки');
  console.log('  GET /health - Статус системы');
  console.log('  GET /test - Тест системы');
  console.log('');
  console.log('🎯 Простая версия без async проблем!');
  console.log('🔄 Готова к тестированию');
});

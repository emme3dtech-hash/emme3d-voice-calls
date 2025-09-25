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

// === ИНТЕГРАЦИЯ С N8N АГЕНТОМ ===
async function callN8NAgent(userMessage, sessionId, customerPhone, customerName) {
  try {
    const webhookUrl = 'https://salesdrive.n8n.cloud/webhook/af770e75-f953-446c-bcd0-92a7fae8e0ac';
    
    const payload = {
      message: {
        text: userMessage,
        from: {
          id: sessionId,
          username: customerName || 'Voice_Client',
          first_name: customerName?.split(' ')[0] || 'Клиент',
          phone: customerPhone
        },
        chat: {
          id: sessionId
        }
      },
      update_id: Date.now()
    };

    console.log('📤 Отправляем в n8n агента:', payload);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      timeout: 15000 // 15 секунд таймаут
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.text();
    console.log('📥 Ответ от n8n агента:', result);

    // Если ответ пустой или только пробелы
    if (!result || result.trim().length === 0) {
      return 'Вибачте, не зміг обробити ваш запит. Спробуйте ще раз.';
    }

    return result.trim();

  } catch (error) {
    console.error('❌ Ошибка вызова n8n агента:', error);
    return 'Вибачте, виникла технічна проблема. Зателефонуйте нам пізніше на +380914811639.';
  }
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

// === ПРОСТАЯ ГЕНЕРАЦИЯ ПРИВЕТСТВИЯ (БЕЗ AWAIT) ===
function generateGreeting(customerName) {
  const greetings = [
    `Привіт${customerName ? `, ${customerName}` : ''}! Це Олена з компанії EMME3D. Ми друкуємо рідкісні автозапчастини на 3D принтері. У вас є хвилинка?`,
    `Доброго дня${customerName ? `, ${customerName}` : ''}! Дзвоню з EMME3D. Ми допомагаємо автовласникам знаходити рідкісні запчастини через 3D друк. Можу розказати більше?`
  ];
  
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// === ОБРАБОТКА ИСХОДЯЩЕГО ЗВОНКА (БЕЗ AWAIT В ПРИВЕТСТВИИ) ===
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

  // ПРОСТОЕ приветствие БЕЗ n8n на этом этапе
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

// === ОБРАБОТКА ОТВЕТА КЛИЕНТА (С N8N ИНТЕГРАЦИЕЙ) ===
app.post('/process-customer-response', async (req, res) => {
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

  try {
    // Если речь не распознана четко
    if (!speechResult || confidence < 0.4) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'uk-UA'
      }, 'Вибачте, я не зрозумій. Можете повторити?');

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

    // Генерируем ответ через n8n агента
    const sessionId = `voice_${callSid}`;
    const aiResponse = await callN8NAgent(
      speechResult, 
      sessionId, 
      conversation.phone, 
      conversation.name
    );
    
    conversation.messages.push({ 
      role: 'assistant', 
      content: aiResponse,
      timestamp: new Date()
    });

    // Обновляем стадию разговора
    updateConversationStage(conversation, speechResult, aiResponse);

    // Проигрываем ответ AI
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA',
      rate: '0.85'
    }, aiResponse);

    // Определяем следующее действие
    if (shouldEndCall(aiResponse, conversation)) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'uk-UA'
      }, 'Дякую за час! Гарного дня!');
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

  } catch (error) {
    console.error('❌ Ошибка обработки ответа:', error);
    
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Вибачте, виникла технічна проблема. Зателефонуємо вам пізніше.');
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// === ОПРЕДЕЛЕНИЕ СТАДИИ РАЗГОВОРА ===
function updateConversationStage(conversation, userInput, aiResponse) {
  const input = userInput.toLowerCase();
  
  if (input.includes('не цікавить') || input.includes('не треба') || input.includes('не хочу')) {
    conversation.stage = 'rejection';
  } else if (input.includes('цікав') || input.includes('розкажіть') || input.includes('так')) {
    conversation.stage = 'interested';
  } else if (input.includes('bmw') || input.includes('audi') || input.includes('mercedes') || 
             input.includes('запчасти') || input.includes('деталь')) {
    conversation.stage = 'discussing_needs';
  } else if (input.includes('подумаю') || input.includes('пізніше')) {
    conversation.stage = 'maybe_later';
  }
}

// === ОПРЕДЕЛЕНИЕ ЗАВЕРШЕНИЯ ЗВОНКА ===
function shouldEndCall(aiResponse, conversation) {
  const response = aiResponse.toLowerCase();
  const maxDuration = 4 * 60 * 1000; // 4 минуты максимум для n8n агента
  const currentDuration = new Date() - conversation.startTime;
  
  // Проверяем ключевые фразы завершения
  const endPhrases = [
    'до побачення', 'гарного дня', 'дякую за час', 
    'зателефонуємо пізніше', 'чекаємо на зв\'язок',
    'заказ отправлен', 'заказ створено', '✅'
  ];
  
  const shouldEnd = endPhrases.some(phrase => response.includes(phrase)) ||
    conversation.stage === 'rejection' ||
    conversation.messages.length > 12 || // Больше сообщений для n8n агента
    currentDuration > maxDuration;
    
  console.log(`🤔 Проверка завершения: ${shouldEnd}, stage: ${conversation.stage}, messages: ${conversation.messages.length}`);
  
  return shouldEnd;
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
      transcript: conversation.messages,
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
  console.log('  POST /api/make-ai-call - AI звонок с n8n интеграцией');  
  console.log('  GET /api/active-calls - Активные звонки');
  console.log('  GET /health - Статус системы');
  console.log('  GET /test - Тест системы');
  console.log('');
  console.log('🎯 ИСПРАВЛЕНА async/await ошибка!');
  console.log('🤖 N8N интеграция работает в process-customer-response');
  console.log('📞 Простое приветствие без async в handle-outbound-call');
});

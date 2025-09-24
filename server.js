const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('EMME3D Voice AI система запускается...');

// Конфигурация
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://emme3d-voice-calls-production.up.railway.app';

// Zadarma данные
const ZADARMA_SIP_USER = process.env.ZADARMA_SIP_USER;
const CALLER_ID = process.env.CALLER_ID || '+16105357813';

// Инициализация сервисов
const client = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Хранение активных разговоров
const activeConversations = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'EMME3D Voice AI System',
    timestamp: new Date().toISOString(),
    config: {
      twilio_configured: !!TWILIO_ACCOUNT_SID,
      openai_configured: !!OPENAI_API_KEY,
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
      'POST /api/bulk-ai-',
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
    const { phone_number, customer_name, script_context } = req.body;
    
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

// В функции app.post('/api/make-ai-call') замените создание звонка:
const call = await client.calls.create({
  to: phone_number,  // обычный номер без SIP
  from: '+16105357813',  // ваш украинский номер
  url: `${BASE_URL}/handle-outbound-call?phone=${encodeURIComponent(phone_number)}&name=${encodeURIComponent(customer_name || '')}`,
  statusCallback: `${BASE_URL}/call-status`,
  statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
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
    language: 'uk-UA'
  }, greeting);

  // Ожидаем ответа клиента
  const gather = twiml.gather({
    speechTimeout: 'auto',
    timeout: 10,
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

// === ОБРАБОТКА ОТВЕТА КЛИЕНТА ===
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
    if (!speechResult || confidence < 0.5) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'uk-UA'
      }, 'Вибачте, я не зрозумів. Можете повторити?');

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

    // Генерируем ответ AI
    const aiResponse = await generateAIResponse(conversation);
    
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
      language: 'uk-UA'
    }, aiResponse);

    // Определяем следующее действие
    if (shouldEndCall(aiResponse, conversation)) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'uk-UA'
      }, 'Дякую за час! Гарного дня!');
      twiml.hangup();
      
      // Сохраняем результат звонка
      await saveCallResult(conversation);
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

      // Если долго молчит
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

// === ГЕНЕРАЦИЯ ПРИВЕТСТВИЯ ===
function generateGreeting(customerName) {
  const greetings = [
    `Привіт${customerName ? `, ${customerName}` : ''}! Це Олена з компанії EMME3D. Ми друкуємо рідкісні автозапчастини на 3D принтері. У вас є хвилинка?`,
    
    `Доброго дня${customerName ? `, ${customerName}` : ''}! Дзвоню з EMME3D. Ми допомагаємо автовласникам знаходити рідкісні запчастини через 3D друк. Можу розказати більше?`
  ];
  
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// === ГЕНЕРАЦИЯ AI ОТВЕТА ===
async function generateAIResponse(conversation) {
  if (!openai) {
    return 'Вибачте, технічна проблема з AI. Зателефонуйте нам пізніше на +16105357813.';
  }

  const systemPrompt = `Ти - Олена, менеджер по продажах компанії EMME3D (emme3d.com.ua), що спеціалізується на 3D-друці автозапчастин.

МЕТА: Познайомити клієнта з послугами та отримати зацікавленість в консультації.

ВАЖЛИВІ ПРАВИЛА:
1. Говори КОРОТКО - максимум 1-2 речення
2. Будь природною та дружньою  
3. Не наполягай якщо клієнт не цікавиться
4. Фокусуйся на вирішенні проблем клієнта
5. Завжди пропонуй конкретну допомогу

ІНФОРМАЦІЯ:
- Друкуємо рідкісні автозапчастини які важко знайти
- Працюємо з усіма марками авто
- Швидке виготовлення: 1-3 дні
- Висока якість друку PLA/ABS/PETG
- Можемо зробити деталь по фото, кресленню або зразку
- Телефон: +380914811639
- Сайт: emme3d.com.ua

Стадія розмови: ${conversation.stage}
Телефон клієнта: ${conversation.phone}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...conversation.messages.slice(-6)
      ],
      max_tokens: 80,
      temperature: 0.8
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('❌ Ошибка OpenAI:', error);
    return 'Вибачте, можете повторити? Не зовсім вас зрозумів.';
  }
}

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
  const maxDuration = 3 * 60 * 1000; // 3 минуты максимум
  const currentDuration = new Date() - conversation.startTime;
  
  return (
    response.includes('до побачення') ||
    response.includes('гарного дня') ||
    conversation.stage === 'rejection' ||
    conversation.messages.length > 10 ||
    currentDuration > maxDuration
  );
}

// === СОХРАНЕНИЕ РЕЗУЛЬТАТА ЗВОНКА ===
async function saveCallResult(conversation) {
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
    // TODO: Интеграция с Supabase для сохранения результатов
    
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

// === МАССОВЫЕ ЗВОНКИ ДЛЯ N8N ===
app.post('/api/bulk-ai-calls', async (req, res) => {
  try {
    const { contacts } = req.body;
    
    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    if (!client) {
      return res.status(500).json({ error: 'Twilio не настроен' });
    }

    const results = [];
    
    console.log(`📞 Запуск массовых AI звонков для ${contacts.length} контактов`);
    
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        const call = await client.calls.create({
          to: `sip:${phone_number.replace('+', '')}@pbx.zadarma.com`,
          from: `380914811639@380914811639.sip.twilio.com`,
          sipAuthUsername: process.env.ZADARMA_SIP_USER,
          sipAuthPassword: process.env.ZADARMA_SIP_PASSWORD,
          url: `${BASE_URL}/handle-outbound-call?phone=${encodeURIComponent(phone_number)}&name=${encodeURIComponent(customer_name || '')}`,
          statusCallback: `${BASE_URL}/call-status`,
          record: true
        });

        results.push({
          phone: contact.phone_number,
          call_sid: callResult.sid,
          status: 'initiated'
        });

        console.log(`✅ Звонок инициирован: ${contact.phone_number} (${callResult.sid})`);

        // Пауза между звонками
        if (i < contacts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 30000)); // 30 секунд
        }

      } catch (error) {
        console.log(`❌ Ошибка звонка на ${contact.phone_number}: ${error.message}`);
        results.push({
          phone: contact.phone_number,
          error: error.message,
          status: 'failed'
        });
      }
    }

    res.json({
      success: true,
      total_contacts: contacts.length,
      results: results
    });

  } catch (error) {
    console.error('❌ Ошибка массовых звонков:', error);
    res.status(500).json({ error: error.message });
  }
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
  console.log('📞 Эндпоинты:');
  console.log('  POST /api/make-ai-call - Одиночный AI звонок');  
  console.log('  POST /api/bulk-ai-calls - Массовые AI звонки из n8n');
  console.log('  GET /api/active-calls - Активные звонки');
  console.log('  GET /health - Статус системы');
});
// === ОБРАБОТКА SIP ВЫЗОВОВ ОТ ZADARMA ===
app.post('/handle-sip-call', (req, res) => {
  console.log('📞 Получен SIP вызов от Zadarma');
  console.log('SIP Headers:', req.body);
  
  const callSid = req.body.CallSid;
  const fromNumber = req.body.From; // номер от Zadarma
  const customerName = req.query.name || '';

  // Создаем контекст разговора
  activeConversations.set(callSid, {
    phone: fromNumber,
    name: customerName,
    messages: [],
    startTime: new Date(),
    stage: 'greeting',
    provider: 'zadarma-sip'
  });

  const twiml = new twilio.twiml.VoiceResponse();

  // Приветственное сообщение на украинском
  const greeting = generateGreeting(customerName);
  twiml.say({
    voice: 'Polly.Joanna',
    language: 'uk-UA'
  }, greeting);

  // Ожидаем ответа клиента
  const gather = twiml.gather({
    speechTimeout: 'auto',
    timeout: 10,
    speechModel: 'experimental_conversations',
    language: 'uk-UA',
    enhanced: true,
    action: '/process-customer-response',
    method: 'POST'
  });

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'uk-UA'
  }, 'Дякую за увагу! Гарного дня!');
  
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});











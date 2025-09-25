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

// === ОБРАБОТКА ИСХОДЯЩЕГО ЗВОНКА (С N8N ИНТЕГРАЦИЕЙ) ===
app.post('/handle-outbound-call', async (req, res) => {
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

  try {
    // Генерируем приветствие через n8n агента
    const sessionId = `voice_${callSid}`;
    const initialMessage = `ХОЛОДНЫЙ_ЗВОНОК: Привіт! Це Олена з компанії EMME3D. Ми друкуємо рідкісні автозапчастини на 3D принтері. У вас є хвилинка?`;
    
    const greeting = await callN8NAgent(
      initialMessage,
      sessionId,
      customerPhone,
      customerName
    );

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

  } catch (error) {
    console.error('❌ Ошибка n8n в приветствии:', error);
    
    // Fallback приветствие
    const fallbackGreeting = generateGreeting(customerName);
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA',
      rate: '0.85'
    }, fallbackGreeting);

    const gather = twiml.gather({
      speechTimeout: 'auto',
      timeout: 12,
      action: '/process-customer-response',
      method: 'POST'
    });

    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Дякую за увагу! Гарного дня!');
    
    twiml.hangup();
  }

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

// === ДОБАВЛЯЕМ ФУНКЦИЮ СОХРАНЕНИЯ В SUPABASE ===
async function saveCallToSupabase(contactId, callSid, phone, name, status, stage = 'greeting') {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.log('❌ Supabase не настроен');
      return null;
    }

    const callData = {
      contact_id: contactId,
      call_sid: callSid,
      phone_number: phone,
      contact_name: name,
      company: 'EMME3D',
      call_status: status,
      conversation_state: stage,
      call_attempts: 1,
      last_called_at: new Date().toISOString(),
      call_duration: 0,
      answered: status === 'answered',
      interested: false,
      lead_score: 0,
      conversation_history: JSON.stringify([])
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(callData)
    });

    if (!response.ok) {
      // Если запись уже существует, обновляем
      const updateResponse = await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts?phone_number=eq.${phone}`, {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          call_sid: callSid,
          call_status: status,
          conversation_state: stage,
          call_attempts: 1,
          last_called_at: new Date().toISOString()
        })
      });
      
      console.log('✅ Обновлена запись в cold_call_contacts');
      return updateResponse.ok;
    }

    console.log('✅ Сохранено в cold_call_contacts');
    return true;

  } catch (error) {
    console.error('❌ Ошибка сохранения в Supabase:', error);
    return false;
  }
}

// === МАССОВЫЙ ОБЗВОН ИЗ БАЗЫ SUPABASE ===
app.post('/api/start-cold-calling-campaign', async (req, res) => {
  try {
    const { campaign_name, max_calls = 10, priority = 'normal' } = req.body;
    
    if (!client) {
      return res.status(500).json({ error: 'Twilio не настроен' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase не настроен' });
    }

    console.log(`🚀 Запуск кампании холодных звонков: ${campaign_name}`);

    // Получаем контакты для обзвона
    const contactsResponse = await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts?select=*&or=(call_status.is.null,call_status.eq.failed,next_call_date.lte.${new Date().toISOString()})&priority.eq.${priority}&limit=${max_calls}`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!contactsResponse.ok) {
      throw new Error('Ошибка получения контактов из Supabase');
    }

    const contacts = await contactsResponse.json();
    
    if (contacts.length === 0) {
      return res.json({
        success: true,
        message: 'Нет контактов для обзвона',
        campaign_name,
        contacts_found: 0
      });
    }

    console.log(`📞 Найдено ${contacts.length} контактов для обзвона`);

    const results = [];
    let successCount = 0;

    // Запускаем звонки с интервалом
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        const cleanNumber = normalizePhoneNumber(contact.phone_number);
        
        if (!cleanNumber) {
          console.log(`❌ Некорректный номер: ${contact.phone_number}`);
          results.push({
            contact_id: contact.id,
            phone: contact.phone_number,
            status: 'failed',
            error: 'Некорректный номер'
          });
          continue;
        }

        // Создаем звонок
        const call = await client.calls.create({
          to: `sip:${cleanNumber}@pbx.zadarma.com`,
          from: '+380914811639',
          sipAuthUsername: process.env.ZADARMA_SIP_USER,
          sipAuthPassword: process.env.ZADARMA_SIP_PASSWORD,
          url: `${BASE_URL}/handle-cold-call?contact_id=${contact.id}&phone=${encodeURIComponent(contact.phone_number)}&name=${encodeURIComponent(contact.contact_name || '')}&campaign=${encodeURIComponent(campaign_name)}`,
          statusCallback: `${BASE_URL}/cold-call-status`,
          record: true,
          timeout: 30
        });

        // Сохраняем в базу
        await saveCallToSupabase(contact.id, call.sid, contact.phone_number, contact.contact_name, 'initiated');

        results.push({
          contact_id: contact.id,
          phone: contact.phone_number,
          call_sid: call.sid,
          status: 'initiated'
        });

        successCount++;
        console.log(`✅ Звонок ${i+1}/${contacts.length} инициирован: ${contact.phone_number} (${call.sid})`);

        // Пауза между звонками (30-60 секунд)
        if (i < contacts.length - 1) {
          const delay = 30000 + Math.random() * 30000; // 30-60 сек
          console.log(`⏱️  Пауза ${Math.round(delay/1000)} секунд до следующего звонка`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

      } catch (error) {
        console.log(`❌ Ошибка звонка на ${contact.phone_number}: ${error.message}`);
        results.push({
          contact_id: contact.id,
          phone: contact.phone_number,
          error: error.message,
          status: 'failed'
        });
      }
    }

    res.json({
      success: true,
      campaign_name,
      total_contacts: contacts.length,
      successful_calls: successCount,
      failed_calls: contacts.length - successCount,
      results: results,
      next_batch_in: '30 минут'
    });

  } catch (error) {
    console.error('❌ Ошибка кампании холодных звонков:', error);
    res.status(500).json({ error: error.message });
  }
});

// === ОБРАБОТКА ХОЛОДНЫХ ЗВОНКОВ ===
app.post('/handle-cold-call', async (req, res) => {
  const callSid = req.body.CallSid;
  const contactId = req.query.contact_id;
  const customerPhone = req.query.phone;
  const customerName = req.query.name;
  const campaignName = req.query.campaign;

  console.log(`📞 Холодный звонок ${callSid} контакту ${contactId}: ${customerPhone}`);

  // Создаем контекст разговора для холодного звонка
  activeConversations.set(callSid, {
    type: 'cold_call',
    contact_id: contactId,
    phone: customerPhone,
    name: customerName,
    campaign: campaignName,
    messages: [],
    startTime: new Date(),
    stage: 'greeting'
  });

  // Асинхронно обновляем статус в базе
  saveCallToSupabase(contactId, callSid, customerPhone, customerName, 'answered', 'greeting')
    .catch(err => console.error('Ошибка сохранения в Supabase:', err));

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    // Приветствие через n8n агента с контекстом холодного звонка
    const sessionId = `cold_call_${callSid}`;
    const initialMessage = `ХОЛОДНЫЙ_ЗВОНОК: Привіт! Це Олена з компанії EMME3D. Ми спеціалізуємося на 3D друці автозапчастин. У вас є хвилинка поговорити?`;
    
    const greeting = await callN8NAgent(
      initialMessage,
      sessionId,
      customerPhone,
      customerName
    );

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
      action: '/process-cold-call-response',
      method: 'POST'
    });

    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Добре, зрозуміло. Дякую за час! Гарного дня!');
    
    twiml.hangup();

  } catch (error) {
    console.error('❌ Ошибка холодного звонка:', error);
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Вибачте, технічна проблема. До побачення!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// === ОБРАБОТКА ОТВЕТОВ В ХОЛОДНЫХ ЗВОНКАХ ===
app.post('/process-cold-call-response', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = req.body.Confidence;

  console.log(`🎤 Холодный звонок - клиент сказал: "${speechResult}" (уверенность: ${confidence})`);

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
      }, 'Вибачте, я не зрозумів. Можете повторити, будь ласка?');

      const gather = twiml.gather({
        speechTimeout: 'auto',
        timeout: 10,
        action: '/process-cold-call-response'
      });

      return res.type('text/xml').send(twiml.toString());
    }

    // Добавляем сообщение клиента в контекст
    conversation.messages.push({ 
      role: 'user', 
      content: speechResult,
      timestamp: new Date()
    });

    // Генерируем ответ через n8n агента с пометкой холодного звонка
    const sessionId = `cold_call_${callSid}`;
    const contextMessage = `ХОЛОДНЫЙ_ЗВОНОК_ОТВЕТ: ${speechResult}`;
    
    const aiResponse = await callN8NAgent(
      contextMessage,
      sessionId, 
      conversation.phone, 
      conversation.name
    );
    
    conversation.messages.push({ 
      role: 'assistant', 
      content: aiResponse,
      timestamp: new Date()
    });

    // Обновляем стадию разговора для холодного звонка
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
      
      activeConversations.delete(callSid);
      
    } else {
      // Продолжаем разговор
      const gather = twiml.gather({
        speechTimeout: 'auto',
        timeout: 15,
        action: '/process-cold-call-response',
        speechModel: 'experimental_conversations',
        language: 'uk-UA'
      });

      twiml.say({
        voice: 'Polly.Joanna',
        language: 'uk-UA'
      }, 'Дякую за увагу! До побачення!');
      twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    console.error('❌ Ошибка обработки холодного звонка:', error);
    
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'uk-UA'
    }, 'Вибачте, виникла технічна проблема. Дякую за час!');
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// === СТАТУС ХОЛОДНЫХ ЗВОНКОВ ===
app.post('/cold-call-status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  console.log(`📊 Холодный звонок ${callSid}: статус ${callStatus}`);
  
  if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer') {
    const conversation = activeConversations.get(callSid);
    if (conversation && conversation.type === 'cold_call') {
      saveCallResult(conversation);
      activeConversations.delete(callSid);
    }
  }
  
  res.status(200).send('OK');
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 EMME3D Voice AI система запущена на порту ${PORT}`);
  console.log('📞 Полные эндпоинты:');
  console.log('  POST /api/make-ai-call - AI звонок с n8n интеграцией');  
  console.log('  POST /api/start-cold-calling-campaign - Запуск кампании холодных звонков');
  console.log('  GET /api/get-contacts-to-call - Контакты для обзвона');
  console.log('  GET /api/campaign-stats - Статистика кампаний');
  console.log('  GET /api/active-calls - Активные звонки');
  console.log('  GET /health - Статус системы');
  console.log('  GET /test - Тест системы');
  console.log('');
  console.log('🤖 ПОЛНАЯ N8N интеграция включена!');
  console.log('💾 Supabase интеграция для холодных звонков');
  console.log('📊 Детальная аналитика кампаний');
  console.log('🎯 Система готова к продакшену!');
});

const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const fetch = require('node-fetch'); // Убедитесь, что node-fetch установлен: npm install node-fetch

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('EMME3D Voice AI система запускается...');

// === 1. КОНФИГУРАЦИЯ И ИНИЦИАЛИЗАЦИЯ ===

// Проверка наличия всех необходимых переменных окружения
const requiredEnvVars = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'ZADARMA_SIP_USER',
    'ZADARMA_SIP_PASSWORD',
    'BASE_URL',
    'CALLER_ID',
    'N8N_VOICE_WEBHOOK_URL' // ДОБАВЛЕНО: URL для n8n вебхука
];

for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        console.error(`❌ Критическая ошибка: Переменная окружения ${varName} не установлена.`);
        process.exit(1); // Завершаем работу, если переменная отсутствует
    }
}


// Конфигурация из переменных окружения
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL;
const N8N_VOICE_WEBHOOK_URL = process.env.N8N_VOICE_WEBHOOK_URL;

// Zadarma данные
const ZADARMA_SIP_USER = process.env.ZADARMA_SIP_USER;
const ZADARMA_SIP_PASSWORD = process.env.ZADARMA_SIP_PASSWORD;
const CALLER_ID = process.env.CALLER_ID;

// Supabase данные
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Инициализация сервисов
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Хранение активных разговоров в памяти
const activeConversations = new Map();

// === 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

/**
 * Нормализует номер телефона для отправки в Zadarma SIP
 * @param {string} phoneNumber - Входящий номер телефона
 * @returns {string} - Очищенный 9-значный номер
 */
function normalizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return '';
    let cleaned = phoneNumber.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('380380')) {
        cleaned = cleaned.substring(3);
    }
    if (cleaned.startsWith('380')) {
        cleaned = cleaned.substring(3);
    }
    if (cleaned.length !== 9) {
        console.log(`❌ Некорректная длина номера после очистки: ${cleaned}`);
        return '';
    }
    return cleaned;
}

/**
 * Вызывает n8n агент для получения ответа
 * @param {string} userMessage - Сообщение от пользователя
 * @param {string} sessionId - ID сессии
 * @param {string} customerPhone - Телефон клиента
 * @param {string} customerName - Имя клиента
 * @returns {Promise<string>} - Ответ от AI агента
 */
async function callN8NAgent(userMessage, sessionId, customerPhone, customerName) {
    try {
        const payload = {
            query: `ХОЛОДНЫЙ_ЗВОНОК_ОТВЕТ: ${userMessage}`,
            session_id: sessionId,
            phone: customerPhone,
            name: customerName
        };
        console.log('📤 Отправляем в n8n агента:', payload);

        const response = await fetch(N8N_VOICE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeout: 15000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // n8n Webhook Response Node возвращает JSON
        const result = await response.json();
        const aiResponse = result.output || result.text || ''; // Ищем ответ в полях output или text
        console.log('📥 Ответ от n8n агента:', aiResponse);

        if (!aiResponse.trim()) {
            return 'Вибачте, сталася помилка. Спробуйте ще раз.';
        }
        return aiResponse.trim();
    } catch (error) {
        console.error('❌ Ошибка вызова n8n агента:', error);
        return 'Вибачте, виникла технічна проблема. Зателефонуйте нам пізніше.';
    }
}


/**
 * Сохраняет или обновляет информацию о звонке в Supabase
 * @param {string} contactId - ID контакта
 * @param {string} callSid - SID звонка от Twilio
 * @param {string} phone - Номер телефона
 * @param {string} name - Имя контакта
 * @param {string} status - Статус звонка
 * @param {string} stage - Этап разговора
 * @returns {Promise<boolean>}
 */
async function saveCallToSupabase(contactId, callSid, phone, name, status, stage = 'greeting') {
    try {
        // Готовим полный объект данных для создания или обновления
        const callData = {
            contact_id: contactId,
            call_sid: callSid,
            phone_number: phone,
            contact_name: name,
            call_status: status,
            conversation_state: stage,
            last_called_at: new Date().toISOString()
        };

        // Используем POST для создания/обновления
        const response = await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates' // Магия UPSERT
            },
            body: JSON.stringify(callData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Детали ошибки от Supabase:', errorText);
            throw new Error(`Ошибка Supabase: ${response.statusText}`);
        }

        console.log(`✅ Запись для контакта ${contactId} сохранена/обновлена в Supabase`);
        return true;

    } catch (error) {
        console.error('❌ Ошибка сохранения в Supabase:', error);
        return false;
    }
}


/**
 * Обновляет результат завершенного звонка в Supabase
 * @param {string} phone - Номер телефона
 * @param {object} conversation - Объект разговора
 * @returns {Promise<void>}
 */
async function updateCallResult(phone, conversation) {
    try {
        const duration = Math.round((new Date() - conversation.startTime) / 1000);
        const isInterested = ['interested', 'discussing_needs', 'order_process'].includes(conversation.stage);
        
        const updateData = {
            call_status: 'completed',
            conversation_state: conversation.stage,
            call_duration: duration,
            answered: true,
            interested: isInterested,
            conversation_history: JSON.stringify(conversation.messages)
        };

        await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts?phone_number=eq.${phone}`, {
            method: 'PATCH',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updateData)
        });
        console.log(`✅ Обновлен результат звонка в Supabase для ${phone}`);
    } catch (error) {
        console.error('❌ Ошибка обновления результата в Supabase:', error);
    }
}


/**
 * Определяет, следует ли завершать звонок
 * @param {string} aiResponse - Ответ AI
 * @param {object} conversation - Объект разговора
 * @returns {boolean}
 */
function shouldEndCall(aiResponse, conversation) {
    const response = aiResponse.toLowerCase();
    const endPhrases = ['до побачення', 'гарного дня', 'дякую за час', 'замовлення створено'];
    return endPhrases.some(phrase => response.includes(phrase)) || conversation.stage === 'rejection';
}

/**
 * Обновляет стадию разговора на основе ответа
 * @param {object} conversation - Объект разговора
 * @param {string} userInput - Что сказал пользователь
 */
function updateConversationStage(conversation, userInput) {
    const input = userInput.toLowerCase();
    if (input.includes('не цікав') || input.includes('не треба') || input.includes('зайнят')) {
        conversation.stage = 'rejection';
    } else if (input.includes('цікав') || input.includes('так') || input.includes('розкажіть')) {
        conversation.stage = 'interested';
    } else if (input.includes('bmw') || input.includes('audi') || input.includes('запчастин')) {
        conversation.stage = 'discussing_needs';
    } else if (input.includes('передзвоніть')) {
        conversation.stage = 'callback_requested';
    }
}


// === 3. ОСНОВНЫЕ ЭНДПОИНТЫ API ===

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'EMME3D Voice AI System',
        timestamp: new Date().toISOString()
    });
});

// === ЭНДПОИНТ ДЛЯ ОДИНОЧНОГО AI ЗВОНКА ===
app.post('/api/make-ai-call', async (req, res) => {
    console.log('🔥 Получен запрос на одиночный AI звонок:', req.body);
    try {
        const { phone_number, customer_name } = req.body;
        if (!phone_number) {
            return res.status(400).json({ error: 'Параметр "phone_number" обязателен' });
        }

        const cleanNumber = normalizePhoneNumber(phone_number);
        if (!cleanNumber) {
            return res.status(400).json({ error: 'Некорректный формат номера телефона', received: phone_number });
        }

        console.log(`📞 Инициируем звонок на sip:${cleanNumber}@pbx.zadarma.com`);

        const call = await client.calls.create({
            to: `sip:${cleanNumber}@pbx.zadarma.com`,
            from: CALLER_ID,
            sipAuthUsername: ZADARMA_SIP_USER,
            sipAuthPassword: ZADARMA_SIP_PASSWORD,
            url: `${BASE_URL}/handle-cold-call?phone=${encodeURIComponent(phone_number)}&name=${encodeURIComponent(customer_name || '')}&contact_id=test_${Date.now()}`,
            statusCallback: `${BASE_URL}/call-status`
        });

        console.log('✅ Звонок успешно создан:', call.sid);
        res.json({
            success: true,
            call_sid: call.sid,
            message: `AI звонок инициирован на ${phone_number}`
        });

    } catch (error) {
        console.error('❌ Ошибка создания AI звонка:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API для запуска кампании холодных звонков
 */
app.post('/api/start-cold-calling-campaign', async (req, res) => {
    try {
        const { campaign_name, max_calls = 10 } = req.body;
        console.log(`🚀 Запуск кампании холодных звонков: ${campaign_name}`);

        const contactsResponse = await fetch(`${supabaseUrl}/rest/v1/cold_call_contacts?select=*&or=(call_status.is.null,call_status.eq.failed)&limit=${max_calls}`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });
        if (!contactsResponse.ok) throw new Error('Ошибка получения контактов из Supabase');
        const contacts = await contactsResponse.json();

        if (contacts.length === 0) {
            return res.json({ message: 'Нет контактов для обзвона' });
        }
        console.log(`📞 Найдено ${contacts.length} контактов для обзвона`);

        for (const contact of contacts) {
            const cleanNumber = normalizePhoneNumber(contact.phone_number);
            if (cleanNumber) {
                await client.calls.create({
                    to: `sip:${cleanNumber}@pbx.zadarma.com`,
                    from: CALLER_ID,
                    sipAuthUsername: ZADARMA_SIP_USER,
                    sipAuthPassword: ZADARMA_SIP_PASSWORD,
                    url: `${BASE_URL}/handle-cold-call?contact_id=${contact.id}&phone=${encodeURIComponent(contact.phone_number)}&name=${encodeURIComponent(contact.contact_name || '')}`,
                    statusCallback: `${BASE_URL}/call-status`
                });
                console.log(`✅ Звонок инициирован на ${contact.phone_number}`);
            }
        }
        res.json({ success: true, message: `Запущено ${contacts.length} звонков.` });
    } catch (error) {
        console.error('❌ Ошибка кампании холодных звонков:', error);
        res.status(500).json({ error: error.message });
    }
});

// === 4. ОБРАБОТЧИКИ TWILIO (TwiML) ===

/**
 * Обрабатывает первоначальное соединение для холодного звонка
 */
app.post('/handle-cold-call', (req, res) => {
    const { CallSid } = req.body;
    const { contact_id, phone, name } = req.query;

    console.log(`📞 Холодный звонок ${CallSid} контакту ${contact_id}: ${phone}`);

    activeConversations.set(CallSid, {
        contact_id, phone, name,
        messages: [],
        startTime: new Date(),
        stage: 'greeting'
    });
    
    saveCallToSupabase(contact_id, CallSid, phone, name, 'in-progress', 'greeting');

    const twiml = new twilio.twiml.VoiceResponse();
    // ИЗМЕНЕНО: Приветствие на русском
    const greeting = `Здравствуйте! Это Василиса горячая шлюшка, будешь брать? Я вому с собой подружек!`;
    
    // ИЗМЕНЕНО: Используем качественный русский нейронный голос
    twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, greeting);
    
    const gather = twiml.gather({
        speechTimeout: 'auto',
        timeout: 10,
        language: 'ru-RU', // ИЗМЕНЕНО: Распознавание речи тоже на русском
        action: '/process-customer-response',
        method: 'POST'
    });
    
    twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, 'Спасибо за внимание. Хорошего дня!');
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
});

/**
 * Обрабатывает ответ клиента и взаимодействует с n8n
 */
app.post('/process-customer-response', async (req, res) => {
    const { CallSid, SpeechResult, Confidence } = req.body;
    console.log(`🎤 Клиент сказал: "${SpeechResult}" (уверенность: ${Confidence})`);

    const conversation = activeConversations.get(CallSid);
    if (!conversation) {
        return res.status(404).send('Разговор не найден');
    }

    const twiml = new twilio.twiml.VoiceResponse();
    
    try {
        if (!SpeechResult || Confidence < 0.4) {
            twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, 'Простите, я вас не поняла. Можете повторить?');
        } else {
            conversation.messages.push({ role: 'user', content: SpeechResult });
            updateConversationStage(conversation, SpeechResult);

            const sessionId = `voice_${CallSid}`;
            const aiResponse = await callN8NAgent(SpeechResult, sessionId, conversation.phone, conversation.name);
            
            conversation.messages.push({ role: 'assistant', content: aiResponse });

            twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, aiResponse);
            
            if (shouldEndCall(aiResponse, conversation)) {
                twiml.hangup();
                await updateCallResult(conversation.phone, conversation);
                activeConversations.delete(CallSid);
            }
        }
        
        if (!twiml.response.Hangup) {
            twiml.gather({
                speechTimeout: 'auto',
                timeout: 10,
                language: 'ru-RU', // ИЗМЕНЕНО: Распознавание речи тоже на русском
                action: '/process-customer-response'
            });
            twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, 'Я вас не услышала. Спасибо за разговор, до свидания!');
            twiml.hangup();
        }

        res.type('text/xml').send(twiml.toString());
    } catch (error) {
        console.error('❌ Ошибка обработки ответа клиента:', error);
        twiml.say({ voice: 'Polly.Tatyana-Neural', language: 'ru-RU' }, 'Простите, произошла техническая ошибка.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    }
});


/**
 * Получает финальный статус звонка от Twilio
 */
app.post('/call-status', async (req, res) => { // ИСПРАВЛЕНО: Добавлен async
    const { CallSid, CallStatus } = req.body;
    console.log(`📊 Звонок ${CallSid}: финальный статус ${CallStatus}`);

    const conversation = activeConversations.get(CallSid);
    if (conversation) {
        if (CallStatus === 'no-answer' || CallStatus === 'failed' || CallStatus === 'busy') {
            await saveCallToSupabase(conversation.contact_id, CallSid, conversation.phone, conversation.name, CallStatus);
        } else {
            // Если звонок завершен, но мы еще не сохранили результат
            await updateCallResult(conversation.phone, conversation);
        }
        activeConversations.delete(CallSid);
    }
    res.status(200).send('OK');
});

// === 5. ЗАПУСК СЕРВЕРА ===

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 EMME3D Voice AI система успешно запущена на порту ${PORT}`);
    console.log(`🌐 Базовый URL: ${BASE_URL}`);
    console.log(`🔗 n8n Webhook URL: ${N8N_VOICE_WEBHOOK_URL}\n`);
});









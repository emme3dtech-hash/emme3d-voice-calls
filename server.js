const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const fetch = require('node-fetch');

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
    'N8N_VOICE_WEBHOOK_URL'
];

for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        console.error(`❌ Критическая ошибка: Переменная окружения ${varName} не установлена.`);
        process.exit(1);
    }
}

// Конфигурация из переменных окружения
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL;
const N8N_VOICE_WEBHOOK_URL = process.env.N8N_VOICE_WEBHOOK_URL;
const CALLER_ID = process.env.CALLER_ID;

// Zadarma данные
const ZADARMA_SIP_USER = process.env.ZADARMA_SIP_USER;
const ZADARMA_SIP_PASSWORD = process.env.ZADARMA_SIP_PASSWORD;

// Supabase данные
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Инициализация сервисов
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Хранение активных разговоров в памяти
const activeConversations = new Map();


// === 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

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
        
        const result = await response.json();
        const aiResponse = result.output || result.text || '';
        console.log('📥 Ответ от n8n агента:', aiResponse);

        if (!aiResponse.trim()) {
            return 'Простите, произошла ошибка. Попробуйте еще раз.';
        }
        return aiResponse.trim();
    } catch (error) {
        console.error('❌ Ошибка вызова n8n агента:', error);
        return 'Простите, возникла техническая проблема. Мы вам перезвоним.';
    }
}

async function saveCallToSupabase(contactId, callSid, phone, name, status, stage = 'greeting') {
    try {
        const callData = {
            contact_id: contactId,
            call_sid: callSid,
            phone_number: phone,
            contact_name: name,
            call_status: status,
            conversation_state: stage,
            last_called_at: new Date().toISOString()
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

function shouldEndCall(aiResponse, conversation) {
    const response = aiResponse.toLowerCase();
    const endPhrases = ['хорошего дня', 'до свидания', 'спасибо за ваше время', 'заказ отправлен', 'заказ создан'];
    return endPhrases.some(phrase => response.includes(phrase)) || conversation.stage === 'rejection';
}

function updateConversationStage(conversation, userInput) {
    const input = userInput.toLowerCase();
    if (input.includes('не интересно') || input.includes('не надо') || input.includes('занят')) {
        conversation.stage = 'rejection';
    } else if (input.includes('интересно') || input.includes('да') || input.includes('расскажите')) {
        conversation.stage = 'interested';
    } else if (input.includes('bmw') || input.includes('audi') || input.includes('запчаст')) {
        conversation.stage = 'discussing_needs';
    } else if (input.includes('перезвоните')) {
        conversation.stage = 'callback_requested';
    }
}


// === 3. ОСНОВНЫЕ ЭНДПОИНТЫ API ===

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'EMME3D Voice AI System',
        timestamp: new Date().toISOString()
    });
});

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


// === 4. ОБРАБОТЧИКИ TWILIO (TwiML) ===

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
    const greeting = `Здравствуйте! Это Елена из компании EMME3D. Мы печатаем автозапчасти на 3D принтере. Вам удобно сейчас разговаривать?`;
    
    twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, greeting);
    
    const gather = twiml.gather({
        speechTimeout: 'auto',
        timeout: 10,
        language: 'ru-RU',
        action: '/process-customer-response',
        method: 'POST',
        enhanced: true,
        speechModel: 'experimental_conversations'
    });
    
    twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, 'Спасибо за внимание. Хорошего дня!');
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
});

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
            twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, 'Простите, я вас не поняла. Можете повторить?');
        } else {
            conversation.messages.push({ role: 'user', content: SpeechResult });
            updateConversationStage(conversation, SpeechResult);

            const sessionId = `voice_${CallSid}`;
            const aiResponse = await callN8NAgent(SpeechResult, sessionId, conversation.phone, conversation.name);
            
            conversation.messages.push({ role: 'assistant', content: aiResponse });

            twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, aiResponse);
            
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
                language: 'ru-RU',
                action: '/process-customer-response',
                enhanced: true,
                speechModel: 'experimental_conversations'
            });
            twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, 'Я вас не услышала. Спасибо за разговор, до свидания!');
            twiml.hangup();
        }

        res.type('text/xml').send(twiml.toString());
    } catch (error) {
        console.error('❌ Ошибка обработки ответа клиента:', error);
        twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, 'Простите, произошла техническая ошибка.');
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    }
});

app.post('/call-status', async (req, res) => {
    const { CallSid, CallStatus } = req.body;
    console.log(`📊 Звонок ${CallSid}: финальный статус ${CallStatus}`);

    const conversation = activeConversations.get(CallSid);
    if (conversation) {
        if (CallStatus === 'no-answer' || CallStatus === 'failed' || CallStatus === 'busy') {
            await saveCallToSupabase(conversation.contact_id, CallSid, conversation.phone, conversation.name, CallStatus);
        } else {
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

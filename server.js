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
    const greeting = `Здравствуйте! Это Елена из компании EMME3D. Мы печатаем автозапчасти на 3D принтере. Вам удобно сейчас разговаривать?`;
    
    twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, greeting);
    
    const gather = twiml.gather({
        speechTimeout: 'auto',
        timeout: 10,
        language: 'ru-RU',
        action: '/process-customer-response',
        method: 'POST',
        enhanced: true, // ДОБАВЛЕНО: Включаем улучшенную модель
        speechModel: 'experimental_conversations' // ДОБАВЛЕНО: Модель для диалогов
    });
    
    twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, 'Спасибо за внимание. Хорошего дня!');
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
            const gather = twiml.gather({ // Повторяем gather с теми же улучшениями
                speechTimeout: 'auto',
                timeout: 10,
                language: 'ru-RU',
                action: '/process-customer-response',
                enhanced: true, // ДОБАВЛЕНО: Включаем улучшенную модель
                speechModel: 'experimental_conversations' // ДОБАВЛЕНО: Модель для диалогов
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

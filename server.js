// Интеграция Zadarma API для украинских холодных звонков
const crypto = require('crypto');
const axios = require('axios');

// Конфигурация Zadarma
const ZADARMA_KEY = process.env.ZADARMA_KEY;
const ZADARMA_SECRET = process.env.ZADARMA_SECRET;
const ZADARMA_SIP_NUMBER = '+380914811639'; // Ваш украинский номер

class ZadarmaVoiceAPI {
  constructor(key, secret) {
    this.key = key;
    this.secret = secret;
    this.baseURL = 'https://api.zadarma.com';
  }

  // Генерация подписи для API
  generateSignature(params, method, path) {
    const paramString = new URLSearchParams(params).toString();
    const signString = method + path + paramString + this.key;
    return crypto.createHmac('md5', this.secret).update(signString).digest('hex');
  }

  // Инициация звонка через Zadarma
  async makeCall(toNumber, scenario) {
    const path = '/v1/request/callback/';
    const params = {
      from: ZADARMA_SIP_NUMBER,
      to: toNumber,
      predicted: '1', // Автоматический дозвон
      scenario: scenario // ID сценария в Zadarma
    };

    const signature = this.generateSignature(params, 'POST', path);

    try {
      const response = await axios.post(`${this.baseURL}${path}`, params, {
        headers: {
          'Authorization': `${this.key}:${signature}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      console.error('Zadarma API Error:', error);
      throw error;
    }
  }

  // Создание сценария для AI звонков
  async createVoiceScenario(name, script) {
    const path = '/v1/scenario/';
    const params = {
      name: name,
      script: script
    };

    const signature = this.generateSignature(params, 'POST', path);

    try {
      const response = await axios.post(`${this.baseURL}${path}`, params, {
        headers: {
          'Authorization': `${this.key}:${signature}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      console.error('Zadarma Scenario Error:', error);
      throw error;
    }
  }

  // Получение статистики звонков
  async getCallStatistics(start, end) {
    const path = '/v1/statistics/';
    const params = {
      start: start,
      end: end,
      type: 'callback'
    };

    const signature = this.generateSignature(params, 'GET', path);

    try {
      const response = await axios.get(`${this.baseURL}${path}`, {
        params: params,
        headers: {
          'Authorization': `${this.key}:${signature}`
        }
      });

      return response.data;
    } catch (error) {
      console.error('Zadarma Statistics Error:', error);
      throw error;
    }
  }
}

// Обновленный endpoint для украинских AI звонков
app.post('/api/make-ukrainian-ai-call', async (req, res) => {
  console.log('Получен запрос на украинский AI звонок');
  
  try {
    const { phone_number, customer_name, script_context } = req.body;
    
    if (!phone_number) {
      return res.status(400).json({ 
        error: 'phone_number обязателен' 
      });
    }

    if (!ZADARMA_KEY || !ZADARMA_SECRET) {
      return res.status(500).json({ 
        error: 'Zadarma API не настроен. Добавьте ZADARMA_KEY и ZADARMA_SECRET'
      });
    }

    const zadarma = new ZadarmaVoiceAPI(ZADARMA_KEY, ZADARMA_SECRET);
    
    // Создаем webhook URL для обработки звонка
    const webhookUrl = `${BASE_URL}/handle-zadarma-call?phone=${encodeURIComponent(phone_number)}&name=${encodeURIComponent(customer_name || '')}`;
    
    // Сценарий для Zadarma (упрощенный)
    const scenario = {
      name: `AI_Call_${Date.now()}`,
      script: `
        <say voice="ua-UA-PolinaNeural">
          Привіт${customer_name ? `, ${customer_name}` : ''}! 
          Це Олена з компанії EMME3D. Ми друкуємо рідкісні автозапчастини на 3D принтері. 
          У вас є хвилинка поговорити?
        </say>
        <listen timeout="5" webhook="${webhookUrl}"/>
      `
    };

    // Инициируем звонок
    const callResult = await zadarma.makeCall(phone_number, scenario);

    console.log('Украинский AI звонок создан:', callResult);

    res.json({
      success: true,
      call_id: callResult.call_id,
      message: `AI звонок инициирован на ${phone_number} с украинского номера`,
      customer_name: customer_name,
      timestamp: new Date().toISOString(),
      provider: 'zadarma'
    });

  } catch (error) {
    console.error('Ошибка создания украинского AI звонка:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      provider: 'zadarma'
    });
  }
});

// Обработчик webhook от Zadarma
app.post('/handle-zadarma-call', async (req, res) => {
  const { call_id, phone, name, speech_result } = req.body;
  
  console.log(`Zadarma webhook: звонок ${call_id}, речь: "${speech_result}"`);

  try {
    // Получаем контекст разговора
    let conversation = activeConversations.get(call_id) || {
      phone: phone,
      name: name,
      messages: [],
      startTime: new Date(),
      stage: 'greeting',
      provider: 'zadarma'
    };

    if (speech_result) {
      // Добавляем ответ клиента
      conversation.messages.push({
        role: 'user',
        content: speech_result,
        timestamp: new Date()

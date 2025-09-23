const express = require('express');

const app = express();
app.use(express.json());

console.log('Сервер запускается...');

// Health check
app.get('/health', (req, res) => {
  console.log('Health check запрошен');
  res.json({
    status: 'OK',
    service: 'EMME3D Voice System',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  console.log('Test endpoint запрошен');
  res.json({
    message: 'Тестовый эндпоинт работает!',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /health',
      'GET /test',
      'POST /api/make-ai-call'
    ]
  });
});

// Simple AI call endpoint
app.post('/api/make-ai-call', (req, res) => {
  console.log('POST /api/make-ai-call вызван');
  console.log('Body:', req.body);
  
  const { phone_number, customer_name } = req.body;
  
  res.json({
    success: true,
    message: 'Эндпоинт работает!',
    received: {
      phone_number: phone_number,
      customer_name: customer_name
    },
    timestamp: new Date().toISOString()
  });
});

// Catch all
app.use('*', (req, res) => {
  console.log(`Неизвестный маршрут: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'Маршрут не найден',
    method: req.method,
    path: req.originalUrl,
    available_routes: [
      'GET /health',
      'GET /test', 
      'POST /api/make-ai-call'
    ]
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log('Доступные маршруты:');
  console.log('  GET /health');
  console.log('  GET /test');
  console.log('  POST /api/make-ai-call');
});
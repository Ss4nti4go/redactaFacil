const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./models/User'); // Asumiendo que ya tienes este modelo

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: 'APP_USR-8437685954820574-061217-73536ca82884e3729ccde2b178147a8e-471922700',
});

// Middleware para verificar token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'tu_clave_secreta_super_segura_aqui_2024');
    req.user = verified;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Ruta para crear preferencia de pago para actualización a Premium
app.post('/api/crear-preferencia-premium', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.isPremium) {
      return res.status(400).json({ error: 'El usuario ya es Premium' });
    }

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [
          {
            id: 'premium-upgrade',
            title: 'Actualización a Premium - RedactaFácil',
            quantity: 1,
            unit_price: 3, // Precio en USD o moneda local
            currency_id: 'UYU', // Cambiar según país
            description: 'Actualización a cuenta Premium con 100 generaciones mensuales'
          }
        ],
        back_urls: {
          success: `${process.env.FRONTEND_URL || 'https://redactafacil.vercel.app'}/success`,
          failure: `${process.env.FRONTEND_URL || 'https://redactafacil.vercel.app'}/failure`,
          pending: `${process.env.FRONTEND_URL || 'https://redactafacil.vercel.app'}/pending`
        },
        auto_return: 'approved',
        external_reference: user._id.toString(),
        notification_url: `${process.env.BACKEND_URL || 'https://redactafacil.onrender.com'}/api/webhook/mercadopago`
      }
    });

    res.json({ id: result.id });
  } catch (error) {
    console.error('Error al crear preferencia:', error);
    res.status(500).json({ error: 'Error al crear preferencia de pago' });
  }
});

// Webhook para recibir notificaciones de Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (type === 'payment') {
      const paymentId = data.id;
      
      // Obtener detalles del pago
      const paymentApi = new Payment(client);
      const payment = await paymentApi.get({ id: paymentId });
      
      if (payment.status === 'approved') {
        const userId = payment.external_reference;
        
        // Actualizar usuario a premium
        await User.findByIdAndUpdate(userId, {
          isPremium: true,
          'usage.monthlyCount': 0, // Reiniciar contador
          'usage.monthlyLimit': 100, // Establecer nuevo límite
          premiumSince: new Date()
        });
        
        console.log(`Usuario ${userId} actualizado a Premium`);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// Ruta para verificar estado de pago (para polling desde el frontend)
app.get('/api/verificar-pago/:userId', verifyToken, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ isPremium: user.isPremium });
  } catch (error) {
    console.error('Error al verificar pago:', error);
    res.status(500).json({ error: 'Error al verificar estado de pago' });
  }
});
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});
// Ruta para actualizar a premium manualmente (solo para pruebas)
app.post('/api/upgrade-premium', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    user.isPremium = true;
    user.usage.monthlyCount = 0;
    user.usage.monthlyLimit = 100;
    user.premiumSince = new Date();
    await user.save();

    res.json({ user });
  } catch (error) {
    console.error('Error al actualizar a premium:', error);
    res.status(500).json({ error: 'Error al actualizar a premium' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/redactafacil')
  .then(() => console.log('Conectado a MongoDB'))
  .catch(err => console.error('Error conectando a MongoDB:', err));

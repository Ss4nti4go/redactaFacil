require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Conectar a MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/redactafacil', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'Error de conexión a MongoDB:'));
db.once('open', () => {
  console.log('✅ Conectado a MongoDB');
});

// Esquema de Usuario
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  usage: {
    weeklyCount: {
      type: Number,
      default: 0
    },
    monthlyCount: {
      type: Number,
      default: 0
    },
    lastWeekReset: {
      type: Date,
      default: Date.now
    },
    lastMonthReset: {
      type: Date,
      default: Date.now
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  }
});

// Esquema de Carta Generada
const letterSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    required: true
  },
  data: {
    nombre: String,
    empresa: String,
    cargo: String,
    destinatario: String,
    motivo: String,
    fechas: String,
    tono: String,
    contacto: String
  },
  result: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const User = mongoose.model('User', userSchema);
const Letter = mongoose.model('Letter', letterSchema);

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware de autenticación
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acceso requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'tu_jwt_secret_aqui');
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// Función para verificar y resetear límites
const checkAndResetLimits = async (user) => {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let updated = false;

  // Resetear contador semanal si ha pasado una semana
  if (user.usage.lastWeekReset < oneWeekAgo) {
    user.usage.weeklyCount = 0;
    user.usage.lastWeekReset = now;
    updated = true;
  }

  // Resetear contador mensual si ha pasado un mes
  if (user.usage.lastMonthReset < oneMonthAgo) {
    user.usage.monthlyCount = 0;
    user.usage.lastMonthReset = now;
    updated = true;
  }

  if (updated) {
    await user.save();
  }

  return user;
};

// Middleware para verificar límites de uso
const checkUsageLimits = async (req, res, next) => {
  try {
    let user = await checkAndResetLimits(req.user);

    if (user.isPremium) {
      // Usuario premium: 100 generaciones por mes
      if (user.usage.monthlyCount >= 100) {
        return res.status(429).json({ 
          error: 'Has alcanzado el límite mensual de 100 generaciones para usuarios premium',
          limit: 100,
          used: user.usage.monthlyCount,
          resetDate: new Date(user.usage.lastMonthReset.getTime() + 30 * 24 * 60 * 60 * 1000)
        });
      }
    } else {
      // Usuario común: 3 generaciones por semana
      if (user.usage.weeklyCount >= 3) {
        return res.status(429).json({ 
          error: 'Has alcanzado el límite semanal de 3 generaciones. Actualiza a premium para más generaciones',
          limit: 3,
          used: user.usage.weeklyCount,
          resetDate: new Date(user.usage.lastWeekReset.getTime() + 7 * 24 * 60 * 60 * 1000)
        });
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Error verificando límites:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// RUTAS DE AUTENTICACIÓN

// Registro de usuario
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validaciones
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    // Encriptar contraseña
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Crear usuario
    const user = new User({
      name,
      email,
      password: hashedPassword
    });

    await user.save();

    // Generar token JWT
    const token = jwt.sign(
      { userId: user._id }, 
      process.env.JWT_SECRET || 'tu_jwt_secret_aqui',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isPremium: user.isPremium,
        usage: user.usage
      }
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Login de usuario
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validaciones
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    // Buscar usuario
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Verificar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Actualizar último login
    user.lastLogin = new Date();
    await user.save();

    // Verificar y resetear límites
    const updatedUser = await checkAndResetLimits(user);

    // Generar token JWT
    const token = jwt.sign(
      { userId: user._id }, 
      process.env.JWT_SECRET || 'tu_jwt_secret_aqui',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login exitoso',
      token,
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        isPremium: updatedUser.isPremium,
        usage: updatedUser.usage
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener información del usuario
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await checkAndResetLimits(req.user);
    
    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isPremium: user.isPremium,
        usage: user.usage,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.get("/api/status" , (req, res) => {
  res.json({ message: "API funcionando correctamente" });
})
// RUTAS DE CARTAS

// Generar carta (protegida y con límites)
app.post("/api/generar-carta", authenticateToken, checkUsageLimits, async (req, res) => {
  try {
    const { tipo, nombre, empresa, cargo, motivo, fechas } = req.body;
    
    const prompt = `Actúa como redactor profesional. Escribe una carta formal de tipo '${tipo}' usando los siguientes datos:

Nombre: ${nombre}
Empresa: ${empresa}
Cargo: ${cargo}
Motivo: ${motivo}
Fechas relevantes: ${fechas}

Usa un tono profesional y claro. No uses lenguaje genérico.`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0.7
    });

    const carta = completion.choices[0].message.content;

    // Guardar carta en la base de datos
    const letter = new Letter({
      userId: req.user._id,
      type: tipo,
      data: { nombre, empresa, cargo, motivo, fechas },
      result: carta
    });

    await letter.save();

    // Incrementar contador de uso
    if (req.user.isPremium) {
      req.user.usage.monthlyCount += 1;
    } else {
      req.user.usage.weeklyCount += 1;
    }
    await req.user.save();

    console.log("Carta generada para usuario:", req.user.email);
    
    res.json({ 
      carta,
      usage: {
        limit: req.user.isPremium ? 100 : 3,
        used: req.user.isPremium ? req.user.usage.monthlyCount : req.user.usage.weeklyCount,
        period: req.user.isPremium ? 'mensual' : 'semanal'
      }
    });

  } catch (err) {
    console.error("Error en OpenAI:", err);
    res.status(500).json({ error: "Error al generar la carta." });
  }
});

// Obtener historial de cartas del usuario
app.get("/api/letters/history", authenticateToken, async (req, res) => {
  try {
    const letters = await Letter.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({ letters });
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener una carta específica
app.get("/api/letters/:id", authenticateToken, async (req, res) => {
  try {
    const letter = await Letter.findOne({ 
      _id: req.params.id, 
      userId: req.user._id 
    });

    if (!letter) {
      return res.status(404).json({ error: 'Carta no encontrada' });
    }

    res.json({ letter });
  } catch (error) {
    console.error('Error obteniendo carta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});
// Actualizar usuario a premium (simulado)
app.post("/api/upgrade-premium", authenticateToken, async (req, res) => {
  try {
    req.user.isPremium = true;
    req.user.usage.monthlyCount = 0;
    req.user.usage.lastMonthReset = new Date();
    await req.user.save();

    res.json({ 
      message: 'Usuario actualizado a premium exitosamente',
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        isPremium: req.user.isPremium,
        usage: req.user.usage
      }
    });
  } catch (error) {
    console.error('Error actualizando a premium:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Ruta de prueba
app.get("/api/test", (req, res) => {
  res.json({ message: "API funcionando correctamente" });
});

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});

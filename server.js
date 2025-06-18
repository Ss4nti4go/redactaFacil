require("dotenv").config()
const express = require("express")
const cors = require("cors")
const bodyParser = require("body-parser")
const mongoose = require("mongoose")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const OpenAI = require("openai")
const mercadopago = require("mercadopago")
const path = require("path")
const nodemailer = require("nodemailer")
const crypto = require("crypto")

const app = express()
const port = process.env.PORT || 3000

// Configurar Mercado Pago
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
})

// Configurar Nodemailer para envío de emails
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "s4359391@gmail.com", // Reemplazar con tu email real
    pass: process.env.EMAIL_PASSWORD || "aumh uacw hhiv lngr", // Reemplazar con tu contraseña real o app password
  },
})

// Middleware
app.use(cors())
// Bloquear rutas peligrosas o sospechosas
const blockedPaths = [
  "/wp-admin",
  "/wp-admin/setup-config.php",
  "/wordpress/wp-admin/setup-config.php",
  "/.env",
  "/.git",
  "/js/script.js", // si querés bloquear esto también
];

app.use((req, res, next) => {
  if (blockedPaths.includes(req.path)) {
    console.warn(`❌ Intento de acceso bloqueado a: ${req.path}`);
    return res.status(403).send("Acceso denegado");
  }
  next();
});
app.use(bodyParser.json())
app.use(express.static(path.join(__dirname, "front")))

// Conectar a MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("Error de conexión a MongoDB:", err))

// Esquema de Usuario
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  isPremium: {
    type: Boolean,
    default: false,
  },
  premiumSince: {
    type: Date,
    default: null,
  },
  mercadoPagoData: {
    preferenceId: String,
    paymentId: String,
    paymentStatus: String,
    lastUpdated: Date,
  },
  usage: {
    weeklyCount: {
      type: Number,
      default: 0,
    },
    monthlyCount: {
      type: Number,
      default: 0,
    },
    lastWeekReset: {
      type: Date,
      default: Date.now,
    },
    lastMonthReset: {
      type: Date,
      default: Date.now,
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastLogin: {
    type: Date,
    default: Date.now,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  verificationCode: {
    type: String,
    default: null,
  },
  verificationCodeExpires: {
    type: Date,
    default: null,
  },
})

// Esquema de Carta Generada
const letterSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  type: {
    type: String,
    required: true,
  },
  data: {
    nombre: String,
    empresa: String,
    cargo: String,
    destinatario: String,
    motivo: String,
    fechas: String,
    tono: String,
    contacto: String,
  },
  result: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

const User = mongoose.model("User", userSchema)
const Letter = mongoose.model("Letter", letterSchema)

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// Middleware de autenticación
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"]
  const token = authHeader && authHeader.split(" ")[1]

  if (!token) {
    return res.status(401).json({ error: "Token de acceso requerido" })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.userId)

    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado" })
    }

    req.user = user
    next()
  } catch (error) {
    return res.status(403).json({ error: "Token inválido" })
  }
}

// Middleware para verificar si el usuario está verificado
const checkVerified = async (req, res, next) => {
  if (!req.user.isVerified) {
    return res.status(403).json({
      error: "Cuenta no verificada",
      message: "Por favor, verifica tu cuenta de correo electrónico antes de continuar.",
    })
  }
  next()
}

// Función para verificar y resetear límites
const checkAndResetLimits = async (user) => {
  const now = new Date()
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  let updated = false

  // Resetear contador semanal si ha pasado una semana
  if (user.usage.lastWeekReset < oneWeekAgo) {
    user.usage.weeklyCount = 0
    user.usage.lastWeekReset = now
    updated = true
  }

  // Resetear contador mensual si ha pasado un mes
  if (user.usage.lastMonthReset < oneMonthAgo) {
    user.usage.monthlyCount = 0
    user.usage.lastMonthReset = now
    updated = true
  }

  if (updated) {
    await user.save()
  }

  return user
}

// Middleware para verificar límites de uso
const checkUsageLimits = async (req, res, next) => {
  try {
    const user = await checkAndResetLimits(req.user)

    if (user.isPremium) {
      // Usuario premium: 100 generaciones por mes
      if (user.usage.monthlyCount >= 100) {
        return res.status(429).json({
          error: "Has alcanzado el límite mensual de 100 generaciones para usuarios premium",
          limit: 100,
          used: user.usage.monthlyCount,
          resetDate: new Date(user.usage.lastMonthReset.getTime() + 30 * 24 * 60 * 60 * 1000),
        })
      }
    } else {
      // Usuario común: 3 generaciones por semana
      if (user.usage.weeklyCount >= 3) {
        return res.status(429).json({
          error: "Has alcanzado el límite semanal de 3 generaciones. Actualiza a premium para más generaciones",
          limit: 3,
          used: user.usage.weeklyCount,
          resetDate: new Date(user.usage.lastWeekReset.getTime() + 7 * 24 * 60 * 60 * 1000),
        })
      }
    }

    req.user = user
    next()
  } catch (error) {
    console.error("Error verificando límites:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
}

// Función para generar código de verificación
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString() // Código de 6 dígitos
}

// Función para enviar email de verificación
const sendVerificationEmail = async (email, code) => {
  const mailOptions = {
    from: process.env.EMAIL_USER || "redactafacil@gmail.com",
    to: email,
    subject: "Verifica tu cuenta en RedactaFácil",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
        <h2 style="color: #6366f1; text-align: center;">¡Bienvenido a RedactaFácil!</h2>
        <p>Gracias por registrarte. Para verificar tu cuenta, ingresa el siguiente código en la aplicación:</p>
        <div style="background-color: #f8fafc; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
          <h1 style="font-size: 32px; letter-spacing: 5px; margin: 0; color: #1e293b;">${code}</h1>
        </div>
        <p>Este código expirará en 30 minutos.</p>
        <p>Si no solicitaste este código, puedes ignorar este mensaje.</p>
        <p style="margin-top: 30px; font-size: 12px; color: #64748b; text-align: center;">
          © 2024 RedactaFácil. Todos los derechos reservados.
        </p>
      </div>
    `,
  }

  try {
    await transporter.sendMail(mailOptions)
    return true
  } catch (error) {
    console.error("Error enviando email:", error)
    return false
  }
}

// RUTAS DE AUTENTICACIÓN

// Registro de usuario
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body

    // Validaciones
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Todos los campos son requeridos" })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" })
    }

    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(400).json({ error: "El email ya está registrado" })
    }

    // Encriptar contraseña
    const saltRounds = 10
    const hashedPassword = await bcrypt.hash(password, saltRounds)

    // Generar código de verificación
    const verificationCode = generateVerificationCode()
    const verificationCodeExpires = new Date(Date.now() + 30 * 60 * 1000) // 30 minutos

    // Crear usuario
    const user = new User({
      name,
      email,
      password: hashedPassword,
      verificationCode,
      verificationCodeExpires,
      isVerified: false,
    })

    await user.save()

    // Enviar email de verificación
    const emailSent = await sendVerificationEmail(email, verificationCode)

    // Generar token JWT
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" })

    res.status(201).json({
      message: "Usuario registrado exitosamente",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isPremium: user.isPremium,
        isVerified: user.isVerified,
        usage: user.usage,
      },
      verificationEmailSent: emailSent,
    })
  } catch (error) {
    console.error("Error en registro:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Verificar código
app.post("/api/auth/verify", authenticateToken, async (req, res) => {
  try {
    const { code } = req.body
    const user = req.user

    if (!code) {
      return res.status(400).json({ error: "El código de verificación es requerido" })
    }

    // Verificar si el código es válido y no ha expirado
    if (user.verificationCode !== code || !user.verificationCodeExpires || user.verificationCodeExpires < new Date()) {
      return res.status(400).json({ error: "Código de verificación inválido o expirado" })
    }

    // Marcar usuario como verificado
    user.isVerified = true
    user.verificationCode = null
    user.verificationCodeExpires = null
    await user.save()

    res.json({
      message: "Cuenta verificada exitosamente",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isPremium: user.isPremium,
        isVerified: user.isVerified,
        usage: user.usage,
      },
    })
  } catch (error) {
    console.error("Error en verificación:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Reenviar código de verificación
app.post("/api/auth/resend-code", authenticateToken, async (req, res) => {
  try {
    const user = req.user

    if (user.isVerified) {
      return res.status(400).json({ error: "La cuenta ya está verificada" })
    }

    // Generar nuevo código de verificación
    const verificationCode = generateVerificationCode()
    const verificationCodeExpires = new Date(Date.now() + 30 * 60 * 1000) // 30 minutos

    user.verificationCode = verificationCode
    user.verificationCodeExpires = verificationCodeExpires
    await user.save()

    // Enviar email de verificación
    const emailSent = await sendVerificationEmail(user.email, verificationCode)

    res.json({
      message: "Código de verificación reenviado",
      verificationEmailSent: emailSent,
    })
  } catch (error) {
    console.error("Error al reenviar código:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Login de usuario
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body

    // Validaciones
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son requeridos" })
    }

    // Buscar usuario
    const user = await User.findOne({ email })
    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas" })
    }

    // Verificar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return res.status(401).json({ error: "Credenciales inválidas" })
    }

    // Actualizar último login
    user.lastLogin = new Date()
    await user.save()

    // Verificar y resetear límites
    const updatedUser = await checkAndResetLimits(user)

    // Generar token JWT
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" })

    res.json({
      message: "Login exitoso",
      token,
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        isPremium: updatedUser.isPremium,
        isVerified: updatedUser.isVerified,
        usage: updatedUser.usage,
      },
    })
  } catch (error) {
    console.error("Error en login:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Obtener información del usuario
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await checkAndResetLimits(req.user)

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isPremium: user.isPremium,
        isVerified: user.isVerified,
        usage: user.usage,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
    })
  } catch (error) {
    console.error("Error obteniendo usuario:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Verificar estado de la API
app.get("/api/status", (req, res) => {
  res.json({ message: "API funcionando correctamente" })
})

// RUTAS DE CARTAS

// Generar carta (protegida y con límites)
app.post("/api/generar-carta", authenticateToken, checkVerified, checkUsageLimits, async (req, res) => {
  try {
    const { tipo, nombre, empresa, cargo, motivo, fechas } = req.body

    const prompt = `Actúa como redactor profesional. Escribe una carta formal de tipo '${tipo}' usando los siguientes datos:

Nombre: ${nombre}
Empresa: ${empresa}
Cargo: ${cargo}
Motivo: ${motivo}
Fechas relevantes: ${fechas}

Usa un tono profesional y claro. No uses lenguaje genérico.`

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0.7,
    })

    const carta = completion.choices[0].message.content

    // Guardar carta en la base de datos
    const letter = new Letter({
      userId: req.user._id,
      type: tipo,
      data: { nombre, empresa, cargo, motivo, fechas },
      result: carta,
    })

    await letter.save()

    // Incrementar contador de uso
    if (req.user.isPremium) {
      req.user.usage.monthlyCount += 1
    } else {
      req.user.usage.weeklyCount += 1
    }
    await req.user.save()

    console.log("Carta generada para usuario:", req.user.email)

    res.json({
      carta,
      usage: {
        limit: req.user.isPremium ? 100 : 7,
        used: req.user.isPremium ? req.user.usage.monthlyCount : req.user.usage.weeklyCount,
        period: req.user.isPremium ? "mensual" : "semanal",
      },
    })
  } catch (err) {
    console.error("Error en OpenAI:", err)
    res.status(500).json({ error: "Error al generar la carta." })
  }
})

// Obtener historial de cartas del usuario
app.get("/api/letters/history", authenticateToken, checkVerified, async (req, res) => {
  try {
    const letters = await Letter.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(10)

    res.json({ letters })
  } catch (error) {
    console.error("Error obteniendo historial:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// Obtener una carta específica
app.get("/api/letters/:id", authenticateToken, checkVerified, async (req, res) => {
  try {
    const letter = await Letter.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })

    if (!letter) {
      return res.status(404).json({ error: "Carta no encontrada" })
    }

    res.json({ letter })
  } catch (error) {
    console.error("Error obteniendo carta:", error)
    res.status(500).json({ error: "Error interno del servidor" })
  }
})

// RUTAS DE MERCADO PAGO

// Crear preferencia de pago para Premium
app.post("/api/crear-preferencia-premium", authenticateToken, checkVerified, async (req, res) => {
  try {
    // Si ya es premium, no permitir crear otra preferencia
    if (req.user.isPremium) {
      return res.status(400).json({ error: "El usuario ya es premium" })
    }

    const { descripcion, nombreComprador, apellidoComprador, emailComprador } = req.body

    // Crear preferencia de pago
    const preference = {
      items: [
        {
          title: descripcion || "Plan Premium RedactaFácil",
          unit_price: 230,
          quantity: 1,
          currency_id: "UYU",
          description: "Acceso a 100 generaciones mensuales y todas las funciones premium",
        },
      ],
      back_urls: {
        success: "https://www.redactafacil.com/success.html",
        failure: "https://www.redactafacil.com/failure.html",
        pending: "https://www.redactafacil.com/pending.html",
      },
      auto_return: "approved",
      external_reference: req.user._id.toString(),
      notification_url: "https://redactafacil.onrender.com/api/webhook-mp",
      payer: {
        name: nombreComprador || req.user.name.split(" ")[0],
        surname: apellidoComprador || req.user.name.split(" ")[1] || "",
        email: emailComprador || req.user.email,
      },
    }

    const response = await mercadopago.preferences.create(preference)

    // Guardar ID de preferencia en el usuario
    req.user.mercadoPagoData = {
      ...(req.user.mercadoPagoData || {}),
      preferenceId: response.body.id,
      lastUpdated: new Date(),
    }
    await req.user.save()

    res.json({
      id: response.body.id,
      init_point: response.body.init_point,
    })
  } catch (error) {
    console.error("Error creando preferencia:", error)
    res.status(500).json({ error: "Error al crear preferencia de pago" })
  }
})

// Webhook para recibir notificaciones de Mercado Pago
app.post("/api/webhook-mp", async (req, res) => {
  try {
    const { type, data } = req.body

    if (type === "payment") {
      const paymentId = data.id

      // Obtener información del pago
      const payment = await mercadopago.payment.findById(paymentId)

      if (payment && payment.body) {
        const { status, external_reference } = payment.body

        // Buscar usuario por external_reference
        const user = await User.findById(external_reference)

        if (user) {
          // Actualizar información de pago
          user.mercadoPagoData = {
            ...(user.mercadoPagoData || {}),
            paymentId,
            paymentStatus: status,
            lastUpdated: new Date(),
          }

          // Si el pago fue aprobado, actualizar a premium
          if (status === "approved") {
            user.isPremium = true
            user.premiumSince = new Date()
            user.usage.monthlyLimit = 100
            user.usage.monthlyCount = 0
            user.usage.lastMonthReset = new Date()

            console.log(`Usuario ${user.email} actualizado a premium`)
          }

          await user.save()
        }
      }
    }

    res.status(200).send("OK")
  } catch (error) {
    console.error("Error en webhook:", error)
    res.status(500).send("Error")
  }
})

// Verificar estado de pago
app.get("/api/verificar-pago/:userId", authenticateToken, async (req, res) => {
  try {
    // Solo permitir verificar el propio usuario
    if (req.params.userId !== req.user._id.toString()) {
      return res.status(403).json({ error: "No autorizado" })
    }

    // Verificar si el usuario es premium
    const user = await User.findById(req.params.userId)

    res.json({
      isPremium: user.isPremium,
      paymentStatus: user.mercadoPagoData?.paymentStatus || null,
      lastUpdated: user.mercadoPagoData?.lastUpdated || null,
    })
  } catch (error) {
    console.error("Error verificando pago:", error)
    res.status(500).json({ error: "Error al verificar estado del pago" })
  }
})

// Servir archivos estáticos
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "front", "index.html"))
})

app.get("/success.html", (req, res) => {
  res.sendFile(path.join(__dirname, "front", "success.html"))
})

app.get("/failure.html", (req, res) => {
  res.sendFile(path.join(__dirname, "front", "failure.html"))
})

app.get("/pending.html", (req, res) => {
  res.sendFile(path.join(__dirname, "front", "pending.html"))
})

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`)
})

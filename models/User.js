const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
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
  premiumSince: {
    type: Date,
    default: null
  },
  usage: {
    weeklyCount: {
      type: Number,
      default: 0
    },
    weeklyLimit: {
      type: Number,
      default: 3
    },
    monthlyCount: {
      type: Number,
      default: 0
    },
    monthlyLimit: {
      type: Number,
      default: 0 // Para usuarios premium se establece en 100
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
  }
});

// Middleware para hashear la contraseña antes de guardar
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Método para comparar contraseñas
UserSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Método para verificar si el usuario puede generar más cartas
UserSchema.methods.canGenerateLetter = function() {
  const now = new Date();
  
  // Verificar si es necesario resetear contadores
  this.checkAndResetCounters(now);
  
  if (this.isPremium) {
    return this.usage.monthlyCount < this.usage.monthlyLimit;
  } else {
    return this.usage.weeklyCount < this.usage.weeklyLimit;
  }
};

// Método para incrementar contador de uso
UserSchema.methods.incrementUsage = function() {
  const now = new Date();
  
  // Verificar si es necesario resetear contadores
  this.checkAndResetCounters(now);
  
  if (this.isPremium) {
    this.usage.monthlyCount += 1;
  } else {
    this.usage.weeklyCount += 1;
  }
  
  return this.save();
};

// Método para verificar y resetear contadores si es necesario
UserSchema.methods.checkAndResetCounters = function(now) {
  // Resetear contador semanal si ha pasado una semana
  const oneWeek = 7 * 24 * 60 * 60 * 1000; // 7 días en milisegundos
  if (now - this.usage.lastWeekReset > oneWeek) {
    this.usage.weeklyCount = 0;
    this.usage.lastWeekReset = now;
  }
  
  // Resetear contador mensual si ha pasado un mes
  const oneMonth = 30 * 24 * 60 * 60 * 1000; // 30 días en milisegundos (aproximado)
  if (now - this.usage.lastMonthReset > oneMonth) {
    this.usage.monthlyCount = 0;
    this.usage.lastMonthReset = now;
  }
};

module.exports = mongoose.model('User', UserSchema);
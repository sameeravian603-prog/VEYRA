const { z } = require('zod');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/note.models');
const Job = require('../models/job');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/AsyncHandler');
const { jwtSecret, jwtExpiresIn, nodeEnv, mongoLegacyDbName } = require('../config/env');

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  role: z.enum(['recruiter', 'candidate']),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: nodeEnv === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function sendToken(res, user, status = 200) {
  const token = jwt.sign({ id: user._id, role: user.role }, jwtSecret, {
    expiresIn: jwtExpiresIn,
  });
  res.cookie('token', token, cookieOptions);
  res.status(status).json({ success: true, token, user: user.toSafeJSON() });
}

const register = asyncHandler(async (req, res) => {
  const user = await User.create(req.body);
  sendToken(res, user, 201);
});

async function findLegacyUser(email) {
  const currentDbName = mongoose.connection.name;

  if (!mongoLegacyDbName || mongoLegacyDbName === currentDbName) {
    return null;
  }

  const legacyDb = mongoose.connection.useDb(mongoLegacyDbName, { useCache: true });
  const LegacyUser = legacyDb.models.User || legacyDb.model('User', User.schema, User.collection.name);
  return LegacyUser.findOne({ email }).select('+password');
}

async function migrateLegacyUser(legacyUser, email, password) {
  if (!legacyUser || !(await legacyUser.comparePassword(password))) {
    return null;
  }

  const document = legacyUser.toObject();

  try {
    await User.collection.insertOne(document);
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }

    const existing = await User.findOne({ email }).select('+password');
    if (!existing || !(await existing.comparePassword(password))) {
      return null;
    }
    return existing;
  }

  return User.findById(legacyUser._id).select('+password');
}

async function migrateLegacyJobs(user, password) {
  if (user.role !== 'recruiter' || !mongoLegacyDbName || mongoLegacyDbName === mongoose.connection.name) {
    return;
  }

  const legacyUser = await findLegacyUser(user.email);
  if (
    !legacyUser ||
    String(legacyUser._id) !== String(user._id) ||
    !(await legacyUser.comparePassword(password))
  ) {
    return;
  }

  const legacyDb = mongoose.connection.useDb(mongoLegacyDbName, { useCache: true });
  const LegacyJob = legacyDb.models.Job || legacyDb.model('Job', Job.schema, Job.collection.name);
  const jobs = await LegacyJob.find({ recruiter: user._id }).lean();

  if (!jobs.length) {
    return;
  }

  await Job.collection.bulkWrite(
    jobs.map((job) => ({
      updateOne: {
        filter: { _id: job._id },
        update: { $setOnInsert: job },
        upsert: true,
      },
    })),
    { ordered: true }
  );
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  let user = await User.findOne({ email }).select('+password');

  if (!user) {
    user = await migrateLegacyUser(await findLegacyUser(email), email, password);
  }

  // Same message for both cases so attackers can't discover which emails exist
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }

  await migrateLegacyJobs(user, password);
  sendToken(res, user);
});

const logout = (req, res) => {
  res.clearCookie('token', { ...cookieOptions, maxAge: undefined });
  res.json({ success: true, message: 'Logged out' });
};

const me = (req, res) => {
  res.json({ success: true, user: req.user.toSafeJSON() });
};

module.exports = { register, login, logout, me, registerSchema, loginSchema };
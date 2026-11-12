jest.mock('mongoose', () => ({
  connection: {
    name: 'mongodb',
    useDb: jest.fn(),
  },
}));

jest.mock('../models/note.models', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  schema: {},
  collection: {
    name: 'users',
    insertOne: jest.fn(),
  },
}));

jest.mock('../models/job', () => ({
  schema: {},
  collection: {
    name: 'jobs',
    bulkWrite: jest.fn(),
  },
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'token'),
}));

jest.mock('../config/env', () => ({
  jwtSecret: 'test-secret',
  jwtExpiresIn: '7d',
  nodeEnv: 'test',
  mongoLegacyDbName: 'test',
}));

const mongoose = require('mongoose');
const User = require('../models/note.models');
const Job = require('../models/job');
const { login } = require('./authcontroller');

function query(value) {
  return { select: jest.fn().mockResolvedValue(value) };
}

function response() {
  const res = {
    cookie: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('legacy account login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('migrates a valid legacy account into the configured database before login', async () => {
    const user = {
      _id: 'legacy-user-id',
      comparePassword: jest.fn().mockResolvedValue(true),
      toObject: jest.fn(() => ({ _id: 'legacy-user-id', email: 'old@example.com', password: 'hashed-password' })),
      toSafeJSON: jest.fn(() => ({ id: 'legacy-user-id', email: 'old@example.com', role: 'candidate' })),
    };
    const legacyModel = { findOne: jest.fn(() => query(user)) };
    const legacyDb = { models: {}, model: jest.fn(() => legacyModel) };
    const migratedUser = { ...user };
    const res = response();

    User.findOne.mockReturnValue(query(null));
    User.collection.insertOne.mockResolvedValue({});
    User.findById.mockReturnValue(query(migratedUser));
    mongoose.connection.useDb.mockReturnValue(legacyDb);

    await login({ body: { email: 'old@example.com', password: 'Password123' } }, res, jest.fn());

    expect(legacyDb.model).toHaveBeenCalledWith('User', User.schema, 'users');
    expect(User.collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'legacy-user-id',
      password: 'hashed-password',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      token: 'token',
    }));
  });

  test('does not migrate a legacy account when its password is wrong', async () => {
    const user = { comparePassword: jest.fn().mockResolvedValue(false) };
    const legacyModel = { findOne: jest.fn(() => query(user)) };
    const legacyDb = { models: {}, model: jest.fn(() => legacyModel) };
    const next = jest.fn();

    User.findOne.mockReturnValue(query(null));
    mongoose.connection.useDb.mockReturnValue(legacyDb);

    await login({ body: { email: 'old@example.com', password: 'wrong-password' } }, response(), next);

    expect(User.collection.insertOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid email or password' }));
  });

  test('copies a recruiter’s legacy jobs without overwriting existing jobs', async () => {
    const user = {
      _id: 'recruiter-id',
      email: 'recruiter@example.com',
      role: 'recruiter',
      comparePassword: jest.fn().mockResolvedValue(true),
      toSafeJSON: jest.fn(() => ({ id: 'recruiter-id', email: 'recruiter@example.com', role: 'recruiter' })),
    };
    const legacyUser = {
      _id: 'recruiter-id',
      comparePassword: jest.fn().mockResolvedValue(true),
    };
    const legacyJob = { _id: 'job-id', recruiter: 'recruiter-id', status: 'open', title: 'Engineer' };
    const legacyUserModel = { findOne: jest.fn(() => query(legacyUser)) };
    const legacyJobModel = { find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([legacyJob]) })) };
    const legacyDb = {
      models: { User: legacyUserModel, Job: legacyJobModel },
    };
    const res = response();

    User.findOne.mockReturnValue(query(user));
    mongoose.connection.useDb.mockReturnValue(legacyDb);
    Job.collection.bulkWrite.mockResolvedValue({});

    await login({ body: { email: 'recruiter@example.com', password: 'Password123' } }, res, jest.fn());

    expect(legacyJobModel.find).toHaveBeenCalledWith({ recruiter: user._id });
    expect(Job.collection.bulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { _id: legacyJob._id },
          update: { $setOnInsert: legacyJob },
          upsert: true,
        },
      },
    ], { ordered: true });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

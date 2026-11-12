jest.mock('mongoose', () => ({
  connection: {
    name: 'mongodb',
    useDb: jest.fn(),
  },
  isValidObjectId: jest.fn(() => true),
}));

jest.mock('../models/job', () => ({
  create: jest.fn(),
  find: jest.fn(),
  aggregate: jest.fn(),
  schema: {},
  collection: {
    name: 'jobs',
    bulkWrite: jest.fn(),
  },
}));

jest.mock('../config/env', () => ({
  mongoLegacyDbName: 'test',
}));

const Job = require('../models/job');
const mongoose = require('mongoose');
const { createJob, listOpenJobs } = require('./jobcontroller');

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function jobQuery(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(result),
  };
}

describe('job persistence and legacy visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('persists a new job under the logged-in recruiter and returns its stable ID', async () => {
    const storedJob = {
      _id: 'new-job-id',
      title: 'Engineer',
      status: 'open',
      toObject() {
        return { _id: this._id, title: this.title, status: this.status };
      },
    };
    const res = response();
    Job.create.mockResolvedValue(storedJob);

    await createJob({
      body: { title: 'Engineer' },
      user: { _id: 'recruiter-id' },
    }, res, jest.fn());

    expect(Job.create).toHaveBeenCalledWith({ title: 'Engineer', recruiter: 'recruiter-id' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      job: expect.objectContaining({ id: 'new-job-id', status: 'open' }),
    });
  });

  test('copies legacy open jobs without replacing current records before listing them', async () => {
    const legacyJob = {
      _id: 'old-job-id',
      recruiter: 'old-recruiter-id',
      title: 'Legacy Engineer',
      status: 'Active',
      requirements: { requiredSkills: [{ name: 'Node.js', importance: 5 }] },
    };
    const legacyModel = { find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([legacyJob]) })) };
    const legacyDb = { models: {}, model: jest.fn(() => legacyModel) };
    const res = response();

    mongoose.connection.useDb.mockReturnValue(legacyDb);
    Job.find
      .mockReturnValueOnce(jobQuery([]))
      .mockReturnValueOnce(jobQuery([{ ...legacyJob, status: 'open' }]));
    Job.collection.bulkWrite.mockResolvedValue({});

    await listOpenJobs({ query: {} }, res, jest.fn());

    expect(legacyModel.find).toHaveBeenCalledWith({ status: { $in: ['open', 'Open', 'active', 'Active', 'published', 'Published'] } });
    expect(Job.collection.bulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { _id: legacyJob._id },
          update: { $setOnInsert: { ...legacyJob, status: 'open' } },
          upsert: true,
        },
      },
    ], { ordered: true });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      jobs: [expect.objectContaining({ id: 'old-job-id', status: 'open', skills: [{ skill: 'Node.js', requirement: 'required', importance: 5 }] })],
    });
  });
});

jest.mock('mongoose', () => ({
  connection: {
    name: 'mongodb',
    useDb: jest.fn(),
  },
  isValidObjectId: jest.fn(() => true),
}));

jest.mock('../models/application', () => ({
  findOne: jest.fn(),
  schema: {},
  collection: {
    name: 'applications',
    updateOne: jest.fn(),
  },
}));

jest.mock('../models/interview', () => ({}));

jest.mock('../models/interviewQuestion', () => ({
  find: jest.fn(),
  schema: {},
  collection: {
    name: 'interviewquestions',
    bulkWrite: jest.fn(),
  },
}));

jest.mock('../models/job', () => ({
  schema: {},
  collection: {
    name: 'jobs',
    updateOne: jest.fn(),
  },
}));

jest.mock('../models/notification', () => ({}));

jest.mock('../config/env', () => ({
  mongoLegacyDbName: 'test',
}));

const mongoose = require('mongoose');
const Application = require('../models/application');
const InterviewQuestion = require('../models/interviewQuestion');
const Job = require('../models/job');
const { listCandidateQuestions } = require('./interviewcontroller');

function response() {
  return { json: jest.fn() };
}

function sortedQuery(value) {
  return { sort: jest.fn().mockResolvedValue(value) };
}

describe('candidate question retrieval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('migrates published legacy questions for the authenticated candidate', async () => {
    const applicationId = 'application-id';
    const candidateId = 'candidate-id';
    const recruiterId = 'recruiter-id';
    const jobId = 'job-id';
    const legacyQuestion = {
      _id: 'question-id',
      application: applicationId,
      recruiter: recruiterId,
      publishedAt: new Date(),
      text: 'Describe a technical challenge you solved.',
      skill: 'engineering',
      answer: null,
      answeredAt: null,
    };
    const legacyJob = {
      _id: jobId,
      recruiter: recruiterId,
      title: 'Engineer',
      toObject() {
        return { _id: jobId, recruiter: recruiterId, title: 'Engineer' };
      },
    };
    const legacyApplication = {
      _id: applicationId,
      candidate: candidateId,
      job: legacyJob,
      toObject() {
        return { _id: applicationId, candidate: candidateId, job: legacyJob };
      },
    };
    const currentApplication = {
      _id: applicationId,
      job: { _id: jobId, recruiter: recruiterId, title: 'Engineer' },
    };
    const legacyApplicationModel = {
      findOne: jest.fn(() => ({
        select: jest.fn(() => ({
          populate: jest.fn().mockResolvedValue(legacyApplication),
        })),
      })),
    };
    const legacyQuestionModel = {
      find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([legacyQuestion]) })),
    };
    const legacyDb = {
      models: {
        Application: legacyApplicationModel,
        Job: {},
        InterviewQuestion: legacyQuestionModel,
      },
    };
    const res = response();

    mongoose.connection.useDb.mockReturnValue(legacyDb);
    Application.findOne
      .mockReturnValueOnce({ populate: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ populate: jest.fn().mockResolvedValue(currentApplication) });
    InterviewQuestion.find.mockReturnValueOnce(sortedQuery([legacyQuestion]));
    Job.collection.updateOne.mockResolvedValue({});
    Application.collection.updateOne.mockResolvedValue({});
    InterviewQuestion.collection.bulkWrite.mockResolvedValue({});

    await listCandidateQuestions({
      params: { applicationId },
      user: { _id: candidateId, name: 'Candidate' },
    }, res, jest.fn());

    expect(legacyApplicationModel.findOne).toHaveBeenCalledWith({
      _id: applicationId,
      candidate: candidateId,
    });
    expect(InterviewQuestion.collection.bulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { _id: legacyQuestion._id },
          update: { $setOnInsert: legacyQuestion },
          upsert: true,
        },
      },
    ], { ordered: true });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      questions: [expect.objectContaining({ id: 'question-id', text: legacyQuestion.text })],
      jobTitle: 'Engineer',
    }));
  });
});

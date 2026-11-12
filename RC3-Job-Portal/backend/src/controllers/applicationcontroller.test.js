jest.mock('mongoose', () => ({
  isValidObjectId: jest.fn(() => true),
}));

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

jest.mock('../models/application', () => ({
  create: jest.fn(),
}));

jest.mock('../models/candidateProfile', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../models/job', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/notification', () => ({
  create: jest.fn(),
}));

jest.mock('../models/interviewQuestion', () => ({}));

jest.mock('../services/ai/candidateAssessment', () => ({
  assessCandidate: jest.fn(),
}));

jest.mock('../services/ai/resumeParser', () => ({
  extractResumeWithAI: jest.fn(),
}));

const Application = require('../models/application');
const Job = require('../models/job');
const Notification = require('../models/notification');
const { PDFParse } = require('pdf-parse');
const { extractResumeWithAI } = require('../services/ai/resumeParser');
const { createApplication } = require('./applicationcontroller');

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('candidate resume submission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stores the uploaded PDF without parsing it or calling Gemini', async () => {
    const buffer = Buffer.from('%PDF-1.7 test resume');
    const job = { _id: 'job-id', title: 'Engineer' };
    const application = { _id: 'application-id', status: 'Submitted', appliedAt: new Date() };
    const res = response();

    Job.findOne.mockResolvedValue(job);
    Application.create.mockResolvedValue(application);
    Notification.create.mockResolvedValue({});

    await createApplication({
      file: { buffer, originalname: 'resume.pdf', size: buffer.length },
      body: { jobId: '0123456789abcdef01234567' },
      user: { _id: 'candidate-id', name: 'Candidate' },
    }, res, jest.fn());

    expect(Application.create).toHaveBeenCalledWith(expect.objectContaining({
      job: job._id,
      candidate: 'candidate-id',
      status: 'Submitted',
      resumeData: buffer,
    }));
    expect(PDFParse).not.toHaveBeenCalled();
    expect(extractResumeWithAI).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

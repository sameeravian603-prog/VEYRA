const mongoose = require('mongoose');
const Job = require('../models/job');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/AsyncHandler');
const { normalizeSkillList } = require('../services/skillNormalizer');
const { extractRequirements } = require('../services/ai/jobRequirements');
const { mongoLegacyDbName } = require('../config/env');

const OPEN_JOB_STATUSES = ['open', 'Open', 'active', 'Active', 'published', 'Published'];

// Normalize skill names (JS -> JavaScript) before saving
function normalizeBody(body) {
  if (body.requirements) {
    body.requirements.requiredSkills = normalizeSkillList(body.requirements.requiredSkills);
    body.requirements.preferredSkills = normalizeSkillList(body.requirements.preferredSkills);
  }
  return body;
}

function serializeJob(job) {
  const data = job.toObject ? job.toObject() : job;
  const requiredSkills = data.requirements?.requiredSkills || [];
  const preferredSkills = data.requirements?.preferredSkills || [];
  const salary = data.salary && typeof data.salary === 'object'
    ? [data.salary.currency, data.salary.min, data.salary.max].filter((value) => value !== undefined && value !== null).join(' ')
    : data.salary;
  return {
    ...data,
    id: String(data._id),
    status: OPEN_JOB_STATUSES.includes(data.status) ? 'open' : data.status,
    salary,
    experienceYears: data.experienceYears ?? data.requirements?.minExperienceYears ?? 0,
    qualifications: Array.isArray(data.qualifications)
      ? data.qualifications.join(', ')
      : Array.isArray(data.requirements?.qualifications)
        ? data.requirements.qualifications.join(', ')
        : data.qualifications || '',
    skills: Array.isArray(data.skills)
      ? data.skills
      : [
          ...requiredSkills.map((skill) => ({ skill: skill.name, requirement: 'required', importance: skill.importance })),
          ...preferredSkills.map((skill) => ({ skill: skill.name, requirement: 'preferred', importance: skill.importance })),
        ],
  };
}

async function migrateLegacyOpenJobs() {
  if (!mongoLegacyDbName || mongoLegacyDbName === mongoose.connection.name) return;

  const legacyDb = mongoose.connection.useDb(mongoLegacyDbName, { useCache: true });
  const LegacyJob = legacyDb.models.Job || legacyDb.model('Job', Job.schema, Job.collection.name);
  const legacyJobs = await LegacyJob.find({ status: { $in: OPEN_JOB_STATUSES } }).lean();
  if (!legacyJobs.length) return;

  await Job.collection.bulkWrite(
    legacyJobs.map((job) => ({
      updateOne: {
        filter: { _id: job._id },
        update: { $setOnInsert: { ...job, status: 'open' } },
        upsert: true,
      },
    })),
    { ordered: true }
  );
}

// Recruiters can only touch their own jobs. Wrong owner looks like "not found".
async function findOwnedJob(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid job id', 400);
  const job = await Job.findOne({ _id: req.params.id, recruiter: req.user._id });
  if (!job) throw new AppError('Job not found', 404);
  return job;
}

const createJob = asyncHandler(async (req, res) => {
  const job = await Job.create({ ...normalizeBody(req.body), recruiter: req.user._id });
  res.status(201).json({ success: true, job: serializeJob(job) });
});

// Recruiter: own jobs with applicant counts
const listMyJobs = asyncHandler(async (req, res) => {
  const match = { recruiter: req.user._id };
  if (['open', 'closed'].includes(req.query.status)) match.status = req.query.status;

  const jobs = await Job.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    // The "applications" collection is created in Phase 4; until then counts are 0
    { $lookup: { from: 'applications', localField: '_id', foreignField: 'job', as: 'apps' } },
    { $addFields: { applicantCount: { $size: '$apps' } } },
    { $project: { apps: 0 } },
  ]);
  res.json({ success: true, jobs: jobs.map((job) => ({ ...job, id: String(job._id) })) });
});

// Everyone logged in: open vacancies (what candidates browse)
const listOpenJobs = asyncHandler(async (req, res) => {
  const currentJobs = await Job.find({ status: { $in: OPEN_JOB_STATUSES } }).sort({ createdAt: -1 }).select('-recruiter');
  if (mongoLegacyDbName !== mongoose.connection.name) {
    try {
      await migrateLegacyOpenJobs();
    } catch (error) {
      if (!currentJobs.length) throw error;
      console.error('Could not migrate legacy open jobs:', error);
    }
  }

  const filter = { status: { $in: OPEN_JOB_STATUSES } };
  if (req.query.type) filter.type = req.query.type;
  const jobs = await Job.find(filter).sort({ createdAt: -1 }).select('-recruiter');
  res.json({ success: true, jobs: jobs.map(serializeJob) });
});

const getJob = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid job id', 400);
  const job = await Job.findById(req.params.id);
  if (!job) throw new AppError('Job not found', 404);

  if (req.user.role === 'candidate') {
    if (!OPEN_JOB_STATUSES.includes(job.status)) throw new AppError('Job not found', 404);
    const { recruiter, ...publicJob } = serializeJob(job);
    return res.json({ success: true, job: publicJob });
  }
  if (!job.recruiter.equals(req.user._id)) throw new AppError('Job not found', 404);
  res.json({ success: true, job: serializeJob(job) });
});

const updateJob = asyncHandler(async (req, res) => {
  const job = await findOwnedJob(req);
  job.set(normalizeBody(req.body));
  await job.save();
  res.json({ success: true, job });
});

const closeJob = asyncHandler(async (req, res) => {
  const job = await findOwnedJob(req);
  if (job.status === 'closed') throw new AppError('Job is already closed', 409);
  job.status = 'closed';
  job.closedAt = new Date();
  await job.save();
  res.json({ success: true, job });
});

const reopenJob = asyncHandler(async (req, res) => {
  const job = await findOwnedJob(req);
  if (job.status === 'open') throw new AppError('Job is already open', 409);
  job.status = 'open';
  job.closedAt = null;
  await job.save();
  res.json({ success: true, job });
});

// AI: returns suggestions only. Nothing is saved until the recruiter confirms by saving the job.
const extractJobRequirements = asyncHandler(async (req, res) => {
  const requirements = await extractRequirements(req.body.description);
  res.json({ success: true, requirements });
});

module.exports = {
  createJob,
  listMyJobs,
  listOpenJobs,
  getJob,
  updateJob,
  closeJob,
  reopenJob,
  extractJobRequirements,
};
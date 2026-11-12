const mongoose = require('mongoose');
const Application = require('../models/application');
const Interview = require('../models/interview');
const InterviewQuestion = require('../models/interviewQuestion');
const Job = require('../models/job');
const Notification = require('../models/notification');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/AsyncHandler');
const { generateInterviewQuestions } = require('../services/ai/interviewQuestions');
const { mongoLegacyDbName } = require('../config/env');

async function getCandidateQuestionSet(applicationId, candidateId) {
  let application = await Application.findOne({ _id: applicationId, candidate: candidateId }).populate('job', 'title recruiter');
  let questions = application
    ? await InterviewQuestion.find({ application: application._id, publishedAt: { $ne: null } }).sort({ createdAt: 1 })
    : [];

  if (questions.length || !mongoLegacyDbName || mongoLegacyDbName === mongoose.connection.name) {
    return { application, questions };
  }

  const legacyDb = mongoose.connection.useDb(mongoLegacyDbName, { useCache: true });
  const LegacyApplication = legacyDb.models.Application
    || legacyDb.model('Application', Application.schema, Application.collection.name);
  const LegacyJob = legacyDb.models.Job || legacyDb.model('Job', Job.schema, Job.collection.name);
  const LegacyInterviewQuestion = legacyDb.models.InterviewQuestion
    || legacyDb.model('InterviewQuestion', InterviewQuestion.schema, InterviewQuestion.collection.name);
  const legacyApplication = await LegacyApplication.findOne({
    _id: applicationId,
    candidate: candidateId,
  }).select('+resumeData +resumeText').populate('job');

  if (!legacyApplication || !legacyApplication.job) {
    return { application, questions };
  }

  const jobData = legacyApplication.job.toObject();
  await Job.collection.updateOne(
    { _id: jobData._id },
    { $setOnInsert: jobData },
    { upsert: true }
  );

  if (!application) {
    const applicationData = legacyApplication.toObject();
    applicationData.job = jobData._id;
    await Application.collection.updateOne(
      { _id: applicationData._id },
      { $setOnInsert: applicationData },
      { upsert: true }
    );
    application = await Application.findOne({ _id: applicationId, candidate: candidateId })
      .populate('job', 'title recruiter');
  }

  if (!application?.job || String(application.job.recruiter) !== String(legacyApplication.job.recruiter)) {
    return { application, questions };
  }

  const legacyQuestions = await LegacyInterviewQuestion.find({
    application: applicationId,
    recruiter: application.job.recruiter,
    publishedAt: { $ne: null },
  }).lean();

  if (legacyQuestions.length) {
    await InterviewQuestion.collection.bulkWrite(
      legacyQuestions.map((question) => ({
        updateOne: {
          filter: { _id: question._id },
          update: { $setOnInsert: question },
          upsert: true,
        },
      })),
      { ordered: true }
    );
    questions = await InterviewQuestion.find({
      application: application._id,
      publishedAt: { $ne: null },
    }).sort({ createdAt: 1 });
  }

  return { application, questions };
}

async function findOwnedApplication(id, recruiterId) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Invalid application id', 400);
  const application = await Application.findById(id).populate('job').populate('candidate');
  if (!application || !application.job || !application.job.recruiter.equals(recruiterId)) {
    throw new AppError('Application not found', 404);
  }
  return application;
}

function questionView(question) {
  return {
    id: String(question._id),
    level: question.level,
    text: question.text,
    guideline: question.guideline,
    skill: question.skill,
    askedAt: question.askedAt,
    publishedAt: question.publishedAt,
    answer: question.answer,
    answeredAt: question.answeredAt,
  };
}

async function findOwnedInterview(id, recruiterId) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Invalid interview id', 400);
  const interview = await Interview.findOne({ _id: id, recruiter: recruiterId });
  if (!interview) throw new AppError('Interview not found', 404);
  return interview;
}

async function getConflicts({ start, duration, interviewer, candidate, recruiterId, ignoreId }) {
  const end = new Date(start.getTime() + duration * 60000);
  const candidates = await Interview.find({
    status: 'scheduled',
    scheduled_at: { $lt: end },
    ...(ignoreId ? { _id: { $ne: ignoreId } } : {}),
  }).populate('candidate', 'name');
  const conflicts = [];

  for (const existing of candidates) {
    const existingEnd = new Date(existing.scheduled_at.getTime() + existing.duration_minutes * 60000);
    if (existingEnd <= start) continue;
    if (String(existing.recruiter) === String(recruiterId) && existing.interviewer.toLowerCase() === interviewer.toLowerCase()) {
      conflicts.push({ type: 'interviewer', name: interviewer, scheduled_at: existing.scheduled_at, duration_minutes: existing.duration_minutes });
    }
    if (String(existing.candidate?._id || existing.candidate) === String(candidate)) {
      conflicts.push({ type: 'candidate', name: existing.candidate?.name || 'Candidate', scheduled_at: existing.scheduled_at, duration_minutes: existing.duration_minutes });
    }
  }
  return conflicts;
}

const listQuestions = asyncHandler(async (req, res) => {
  await findOwnedApplication(req.params.applicationId, req.user._id);
  const questions = await InterviewQuestion.find({ application: req.params.applicationId, recruiter: req.user._id }).sort({ createdAt: 1 });
  res.json({ success: true, questions: questions.map(questionView) });
});

const generateQuestions = asyncHandler(async (req, res) => {
  const application = await findOwnedApplication(req.params.applicationId, req.user._id);
  if (!application.score_json) throw new AppError('Assess this application before generating interview questions.', 409);
  const generated = await generateInterviewQuestions(application.job, application);
  const questions = await InterviewQuestion.insertMany(generated.map((question) => ({
    ...question,
    application: application._id,
    recruiter: req.user._id,
  })));
  res.status(201).json({ success: true, questions: questions.map(questionView) });
});

const publishQuestions = asyncHandler(async (req, res) => {
  const application = await findOwnedApplication(req.params.applicationId, req.user._id);
  const questions = await InterviewQuestion.find({ application: application._id, recruiter: req.user._id }).sort({ createdAt: 1 });
  if (!questions.length) throw new AppError('Generate at least one question before sending them to the candidate.', 409);

  if (questions.some((question) => question.answer !== null && question.answer !== undefined)) {
    throw new AppError('Questions with submitted answers cannot be sent again.', 409);
  }

  const alreadyPublished = questions.every((question) => question.publishedAt);
  if (!alreadyPublished) {
    const publishedAt = new Date();
    await InterviewQuestion.updateMany(
      { application: application._id, recruiter: req.user._id },
      { $set: { publishedAt } }
    );
    await Notification.create({
      user: application.candidate._id,
      message: `The recruiter sent you interview questions for ${application.job.title}. Open My applications to respond.`,
    });
  }

  const updated = await InterviewQuestion.find({ application: application._id, recruiter: req.user._id }).sort({ createdAt: 1 });
  res.json({ success: true, questions: updated.map(questionView) });
});

const listCandidateQuestions = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.applicationId)) throw new AppError('Invalid application id', 400);
  const { application, questions } = await getCandidateQuestionSet(req.params.applicationId, req.user._id);
  if (!application || !application.job) throw new AppError('Application not found', 404);
  res.json({
    success: true,
    questions: questions.map((question) => ({
      id: String(question._id),
      level: question.level,
      text: question.text,
      skill: question.skill,
      answer: question.answer,
      answeredAt: question.answeredAt,
    })),
    jobTitle: application.job?.title || 'Application',
    candidateName: req.user.name,
  });
});

const submitCandidateAnswers = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.applicationId)) throw new AppError('Invalid application id', 400);
  const { application } = await getCandidateQuestionSet(req.params.applicationId, req.user._id);
  if (!application || !application.job) throw new AppError('Application not found', 404);

  const answers = req.body.answers;
  if (!Array.isArray(answers) || !answers.length) throw new AppError('Please answer each question before submitting.', 400);
  const normalized = new Map();
  for (const item of answers) {
    const id = String(item?.questionId || '');
    const answer = String(item?.answer || '').trim();
    if (!mongoose.isValidObjectId(id) || !answer || answer.length > 5000 || normalized.has(id)) {
      throw new AppError('Each question needs one answer of 1 to 5000 characters.', 400);
    }
    normalized.set(id, answer);
  }

  const questions = await InterviewQuestion.find({
    application: application._id,
    publishedAt: { $ne: null },
  });
  if (!questions.length || questions.length !== normalized.size
    || questions.some((question) => !normalized.has(String(question._id)))) {
    throw new AppError('The question set changed. Reload the page and try again.', 409);
  }
  if (questions.some((question) => question.answeredAt)) {
    throw new AppError('Your answers have already been submitted.', 409);
  }

  const answeredAt = new Date();
  const result = await InterviewQuestion.bulkWrite(questions.map((question) => ({
    updateOne: {
      filter: { _id: question._id, answeredAt: null },
      update: { $set: { answer: normalized.get(String(question._id)), answeredAt } },
    },
  })));
  if (result.matchedCount !== questions.length) {
    throw new AppError('Your answers were already submitted. Refresh the page to see them.', 409);
  }
  await Notification.create({
    user: application.job.recruiter,
    message: `${req.user.name} submitted answers to the interview questions for ${application.job.title}.`,
  });

  res.json({ success: true, submittedAt: answeredAt, count: questions.length });
});

const updateQuestion = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid question id', 400);
  const question = await InterviewQuestion.findOne({ _id: req.params.id, recruiter: req.user._id });
  if (!question) throw new AppError('Question not found', 404);
  if (question.publishedAt) throw new AppError('Questions cannot be edited after they are sent to the candidate.', 409);
  if (req.body.text !== undefined) question.text = String(req.body.text).trim();
  if (req.body.guideline !== undefined) question.guideline = String(req.body.guideline).trim();
  if (req.body.level !== undefined) question.level = req.body.level;
  await question.save();
  res.json({ success: true, question: questionView(question) });
});

const markQuestionAsked = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid question id', 400);
  const question = await InterviewQuestion.findOne({ _id: req.params.id, recruiter: req.user._id });
  if (!question) throw new AppError('Question not found', 404);
  question.askedAt = req.body.asked === false ? null : new Date();
  await question.save();
  res.json({ success: true, question: questionView(question) });
});

const deleteQuestion = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid question id', 400);
  const question = await InterviewQuestion.findOne({ _id: req.params.id, recruiter: req.user._id });
  if (!question) throw new AppError('Question not found', 404);
  if (question.publishedAt) throw new AppError('Questions cannot be removed after they are sent to the candidate.', 409);
  await question.deleteOne();
  res.json({ success: true, deleted: String(question._id) });
});

const regenerateQuestion = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Invalid question id', 400);
  const question = await InterviewQuestion.findOne({ _id: req.params.id, recruiter: req.user._id });
  if (!question) throw new AppError('Question not found', 404);
  if (question.publishedAt) throw new AppError('Questions cannot be regenerated after they are sent to the candidate.', 409);
  const application = await findOwnedApplication(question.application, req.user._id);
  if (!application.score_json) throw new AppError('Assess this application before generating interview questions.', 409);
  const generated = await generateInterviewQuestions(application.job, application);
  const replacement = generated.find((item) => item.level === question.level && (!question.skill || item.skill === question.skill)) || generated[0];
  question.text = replacement.text;
  question.guideline = replacement.guideline;
  question.skill = replacement.skill;
  await question.save();
  res.json({ success: true, question: questionView(question) });
});

const createInterview = asyncHandler(async (req, res) => {
  const application = await findOwnedApplication(req.body.application_id, req.user._id);
  if (!['Shortlisted', 'Interview'].includes(application.status)) {
    throw new AppError('Only shortlisted applicants can be scheduled for an interview.', 409);
  }
  const interviewer = String(req.body.interviewer || '').trim();
  const start = new Date(req.body.scheduled_at);
  const duration = Number(req.body.duration_minutes) || 45;
  if (!interviewer) throw new AppError('Please choose an interviewer.', 400);
  if (!Number.isFinite(start.getTime()) || start <= new Date()) throw new AppError('Choose a valid future interview date and time.', 400);
  if (!Number.isInteger(duration) || duration < 15 || duration > 240) throw new AppError('Interview length must be 15 to 240 minutes.', 400);

  const conflicts = await getConflicts({
    start,
    duration,
    interviewer,
    candidate: application.candidate._id,
    recruiterId: req.user._id,
  });
  if (conflicts.length && req.body.force !== true) {
    throw new AppError('This interview time conflicts with another scheduled interview. Confirm the conflict before scheduling.', 409);
  }

  const interview = await Interview.create({
    application: application._id,
    job: application.job._id,
    candidate: application.candidate._id,
    recruiter: req.user._id,
    interviewer,
    interview_type: req.body.interview_type || 'technical',
    scheduled_at: start,
    duration_minutes: duration,
  });

  if (application.status === 'Shortlisted') {
    application.history.push({ from: 'Shortlisted', to: 'Interview', changedBy: req.user.name, at: new Date() });
    application.status = 'Interview';
    await application.save();
  }
  await Notification.create({
    user: application.candidate._id,
    message: `An interview for ${application.job.title} has been scheduled.`,
  });
  res.status(201).json({ success: true, interview, conflicts });
});

const listInterviews = asyncHandler(async (req, res) => {
  const interviews = await Interview.find({ recruiter: req.user._id, status: { $ne: 'cancelled' } })
    .populate('candidate', 'name email')
    .populate('job', 'title')
    .sort({ scheduled_at: 1 });
  res.json({ success: true, interviews: interviews.map((item) => ({
    ...item.toObject(),
    id: String(item._id),
    applicationId: String(item.application),
    candidateName: item.candidate?.name || 'Unknown candidate',
    jobTitle: item.job?.title || 'Unavailable role',
  })) });
});

const updateInterview = asyncHandler(async (req, res) => {
  const interview = await findOwnedInterview(req.params.id, req.user._id);
  const start = req.body.scheduled_at ? new Date(req.body.scheduled_at) : interview.scheduled_at;
  const duration = Number(req.body.duration_minutes) || interview.duration_minutes;
  const interviewer = String(req.body.interviewer || interview.interviewer).trim();
  if (!Number.isFinite(start.getTime()) || start <= new Date()) throw new AppError('Choose a valid future interview date and time.', 400);
  if (!Number.isInteger(duration) || duration < 15 || duration > 240) throw new AppError('Interview length must be 15 to 240 minutes.', 400);
  const conflicts = await getConflicts({
    start,
    duration,
    interviewer,
    candidate: interview.candidate,
    recruiterId: req.user._id,
    ignoreId: interview._id,
  });
  if (conflicts.length && req.body.force !== true) throw new AppError('The new interview time conflicts with another scheduled interview.', 409);
  interview.scheduled_at = start;
  interview.duration_minutes = duration;
  interview.interviewer = interviewer;
  if (req.body.interview_type) interview.interview_type = req.body.interview_type;
  await interview.save();
  res.json({ success: true, interview, conflicts });
});

const saveFeedback = asyncHandler(async (req, res) => {
  const interview = await findOwnedInterview(req.params.id, req.user._id);
  const fields = ['technical', 'communication', 'problem_solving', 'culture_fit'];
  const feedback = {};
  for (const field of fields) {
    const rating = Number(req.body[field]);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError(`Rate ${field.replace('_', ' ')} from 1 to 5.`, 400);
    feedback[field] = rating;
  }
  if (!['hire', 'hold', 'reject'].includes(req.body.recommendation)) throw new AppError('Choose a feedback recommendation.', 400);
  feedback.comments = String(req.body.comments || '').trim();
  feedback.recommendation = req.body.recommendation;
  feedback.submittedBy = req.user.name;
  feedback.submittedAt = new Date();
  interview.feedback = feedback;
  interview.status = 'completed';
  await interview.save();
  res.json({ success: true, interview });
});

module.exports = {
  listQuestions,
  generateQuestions,
  publishQuestions,
  listCandidateQuestions,
  submitCandidateAnswers,
  updateQuestion,
  markQuestionAsked,
  deleteQuestion,
  regenerateQuestion,
  createInterview,
  listInterviews,
  updateInterview,
  saveFeedback,
};
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const c = require('../controllers/applicationcontroller');
const interviews = require('../controllers/interviewcontroller');

router.use(requireAuth, requireRole('candidate'));
router.get('/applications', c.listCandidateApplications);
router.get('/applications/:applicationId/questions', interviews.listCandidateQuestions);
router.post('/applications/:applicationId/questions/answers', interviews.submitCandidateAnswers);
router.get('/profile', c.getCandidateProfile);
router.put('/profile', c.saveCandidateProfile);
router.get('/recommendations', c.listCandidateRecommendations);

module.exports = router;
/* eslint-disable */
/**
 * Cloud Functions for Coders Cup Minigames - comic game helpers
 */

const { setGlobalOptions } = require('firebase-functions');
const { onRequest } = require('firebase-functions/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();

// Simple helper to set permissive CORS headers for browser clients.
function setCorsHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// How many frames to return after the user's last solved question (controlled via query/logic)
// User progress collection: comic_game/user_progress/users/{uid}
const USER_PROGRESS_DOC = 'user_progress';
const USER_PROGRESS_SUBCOL = 'users';

/**
 * HTTP function: getGameData (AUTH REQUIRED)
 * Returns all frames and all question sets (including answers) plus the user's progress.
 * Response shape:
 * {
 *   success: true,
 *   frames: [ { id, index, imageUrl, questionSetId, musicId, ... } ],
 *   questionSets: { [setId]: { id, index, questions: [ { id, text, imageUrl, answer } ] } },
 *   progressIndex: number,   // -1 when no progress
 *   finished: boolean,       // true if progressIndex >= max frame index
 *   version: number          // optional, config.version or timestamp fallback
 * }
 */
exports.getGameData = onRequest(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);

    // Authenticate via Firebase ID token
    const authHeader = (req.get('Authorization') || req.get('authorization') || '').toString();
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing Authorization Bearer token' });
    }
    const idToken = authHeader.split('Bearer ')[1].trim();
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      logger.warn('getGameData: token verification failed', err);
      return res.status(401).json({ success: false, message: 'Invalid auth token' });
    }

    const db = admin.firestore();

    // Read progress
    const progressRef = db.collection('comic_game').doc(USER_PROGRESS_DOC).collection(USER_PROGRESS_SUBCOL).doc(uid);
    const progressSnap = await progressRef.get();
    const progressData = progressSnap.exists ? (progressSnap.data() || {}) : {};
    let progressIndex = -1;
    if (Object.prototype.hasOwnProperty.call(progressData, 'progressIndex')) {
      const n = Number(progressData.progressIndex);
      if (!Number.isNaN(n)) progressIndex = Math.floor(n);
    }

    // Load all frames ordered by index
    const framesRef = db.collection('comic_game').doc('frames').collection('frames');
    const framesSnap = await framesRef.orderBy('index').get();
    const frames = framesSnap.docs.map((d) => {
      const data = d.data() || {};
      const musicId = data.musicId || data.audioId || data.music || null;
      return { id: d.id, musicId, ...data };
    });

    // Determine finished based on latest frame index
    let maxIndex = -1;
    for (const f of frames) {
      const idx = Number(f.index);
      if (!Number.isNaN(idx) && idx > maxIndex) maxIndex = idx;
    }
    const finished = progressIndex >= maxIndex && maxIndex >= 0;

    // Collect all question set IDs referenced by frames
    const setIds = new Set();
    for (const f of frames) {
      const setId = f.questionSetId || f.questionSet || f.setId || null;
      if (setId && String(setId).trim() !== '') setIds.add(String(setId));
    }

    // Load question sets
    const questionSets = {};
    if (setIds.size > 0) {
      const setsRef = db.collection('comic_game').doc('questions').collection('sets');
      // Firestore doesn't support where-in for large sets easily; read sequentially to respect limits
      for (const sid of setIds) {
        try {
          const doc = await setsRef.doc(sid).get();
          if (!doc.exists) continue;
          const sd = doc.data() || {};
          const rawQs = Array.isArray(sd.questions) ? sd.questions : [];
          const qs = rawQs.map((q) => ({
            id: q.id || q._id || q.questionId || null,
            text: q.text || q.question || '',
            imageUrl: q.imageUrl || q.image || q.image_url || null,
            answer: q.answer || q.correct || '',
          }));
          questionSets[sid] = {
            id: doc.id,
            index: sd.index ?? null,
            questions: qs,
          };
        } catch (e) {
          logger.warn('getGameData: failed to load set', sid, e);
        }
      }
    }

    // Optional version info from config
    let version = Date.now();
    try {
      const cfgDoc = await db.collection('comic_game').doc('config').get();
      if (cfgDoc.exists) {
        const cfg = cfgDoc.data() || {};
        const v = cfg.version;
        if (typeof v === 'number') version = v;
      }
    } catch (e) {
      // ignore, use timestamp
    }

    return res.json({
      success: true,
      frames,
      questionSets,
      progressIndex,
      finished,
      version,
    });
  } catch (err) {
    logger.error('getGameData failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

/**
 * HTTP function: getNextFrames
 * Accepts: POST or GET with JSON/query param { code: string }
 * Behavior:
 *  - searches for the response document with the provided `code` inside
 *    games/{COMIC_GAME_ID}/responses
 *  - reads the user's `score` field (assumed numeric).
 *    Interpretation:
 *      - If the `score` field is null or missing, treat it as "no questions solved".
 *        In that case we set lastAnsweredIndex = -1 so frame 0 is included for new players.
 *      - If `score` is a number (including 0) we treat Math.floor(score) as the index of
 *        the frame where the last question was correctly answered (so 0 is a valid value).
 *  - fetches up to N_FRAMES frames from comic_game/frames/frames where
 *    index > solvedQuestions. Frames are ordered by their `index`.
 *  - for each frame, finds the question set in comic_game/questions/sets
 *    with the same index and selects one random question from the set.
 *  - returns JSON: { success: true, frames: [...], questions: [...] }
 *
 * IMPORTANT ASSUMPTIONS (update code if your schema differs):
 *  - response documents in games/{gameId}/responses have fields `code` (string) and `score` (number)
 *  - frames are stored at comic_game/frames/frames and have numeric `index` field
 *  - question sets are stored at comic_game/questions/sets and have numeric `index` and an array field `questions`
 *  - each question inside a set contains at least: { id, text, imageUrl }
 */
exports.getNextFrames = onRequest(async (req, res) => {
  try {
    // handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);
    // Authenticate user via Firebase ID token (Authorization: Bearer <idToken>)
    const authHeader = (req.get('Authorization') || req.get('authorization') || '').toString();
    if (!authHeader.startsWith('Bearer ')) {
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Missing Authorization Bearer token' });
    }
    const idToken = authHeader.split('Bearer ')[1].trim();
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      logger.warn('getNextFrames: token verification failed', err);
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Invalid auth token' });
    }

    // Read user progress from comic_game/user_progress/users/{uid}
    const progressRef = admin.firestore()
      .collection('comic_game')
      .doc(USER_PROGRESS_DOC)
      .collection(USER_PROGRESS_SUBCOL)
      .doc(uid);
    const progressSnap = await progressRef.get();
    const progressData = progressSnap.exists ? (progressSnap.data() || {}) : {};
    const rawProgress = Object.prototype.hasOwnProperty.call(
      progressData,
      'progressIndex'
    ) ? progressData.progressIndex : null;
    let lastAnsweredIndex = -1;
    if (rawProgress !== undefined && rawProgress !== null) {
      const n = Number(rawProgress);
      if (!Number.isNaN(n)) lastAnsweredIndex = Math.floor(n);
    }

    // get frames after the solved index
    const framesRef = admin.firestore()
      .collection('comic_game')
      .doc('frames')
      .collection('frames');

    let framesQuery;
    if (lastAnsweredIndex < 0) {
      framesQuery = framesRef.where('index', '>=', 0).orderBy('index');
    } else {
      framesQuery = framesRef.where('index', '>', lastAnsweredIndex).orderBy('index');
    }

    const framesSnap = await framesQuery.get();
    const frames = [];
    const questionResults = [];
    // Prepare sets collection ref
    const setsRef = admin.firestore().collection('comic_game').doc('questions').collection('sets');

    // Iterate frames in order and stop when we include the first frame that has a questionSetId
    for (const doc of framesSnap.docs) {
      const frameData = doc.data() || {};
      const frameIndex = frameData.index;
      const musicId = frameData.musicId || frameData.audioId || frameData.music || null;

      frames.push({ id: doc.id, musicId, ...frameData });

      const setId = frameData.questionSetId || frameData.questionSet || frameData.setId || null;
      if (!setId || String(setId).trim() === '') {
        // no question attached to this frame
        questionResults.push({ frameIndex, setId: null, question: null });
        continue;
      }

      // try to load the question set by id
      try {
        const setDoc = await setsRef.doc(String(setId)).get();
        if (!setDoc.exists) {
          // set doc not found -> record null question and stop (we included the frame)
          questionResults.push({ frameIndex, setId: String(setId), question: null });
          break;
        }
        const setData = setDoc.data() || {};
        const questions = Array.isArray(setData.questions) ? setData.questions : [];
        if (questions.length === 0) {
          questionResults.push({ frameIndex, setId: setDoc.id, question: null });
          break;
        }

        // pick a random question from the set
        const q = questions[Math.floor(Math.random() * questions.length)];
        const questionObj = {
          id: q.id || q._id || null,
          text: q.text || q.question || '',
          imageUrl: q.imageUrl || q.image || q.image_url || null,
        };
        questionResults.push({ frameIndex, setId: setDoc.id, question: questionObj });
        // we've included the frame with the next question; stop here
        break;
      } catch (e) {
        // on errors, include a null question entry and stop
        questionResults.push({ frameIndex, setId: String(setId), question: null });
        break;
      }
    }

    // Determine finished: true if there are no frames after the last returned frame
    let finished = false;
    if (frames.length === 0) {
      finished = true;
    } else {
      const lastIdx = frames[frames.length - 1].index;
      const laterSnap = await framesRef.where('index', '>', lastIdx).orderBy('index').limit(1).get();
      if (laterSnap.empty) finished = true;
    }

    return res.json({ success: true, lastAnsweredIndex, frames, questions: questionResults, finished });
  } catch (err) {
    logger.error('getNextFrames failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

/**
 * HTTP function: getMusicLibrary
 * Returns a mapping of musicId -> audioUrl for all music docs under comic_game/music/music
 */
exports.getMusicLibrary = onRequest(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);

    const musicRef = admin.firestore().collection('comic_game').doc('music').collection('music');
    const snap = await musicRef.get();
    const result = {};
    for (const d of snap.docs) {
      const data = d.data() || {};
      const audioUrl = data.audioUrl || data.url || data.audio || null;
      if (audioUrl) result[d.id] = audioUrl;
    }
    return res.json({ success: true, musics: result });
  } catch (err) {
    logger.error('getMusicLibrary failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

/**
 * HTTP function: fetchConfig
 * Returns the document stored at comic_game/config (as JSON). This document
 * is expected to contain fields such as backgroundImageUrl and backgroundImageStoragePath.
 */
exports.fetchConfig = onRequest(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);

    const cfgRef = admin.firestore().collection('comic_game').doc('config');
    const snap = await cfgRef.get();
    if (!snap.exists) {
      return res.json({ success: true, backgroundImageUrl: null, backgroundVideoUrl: null });
    }
    const data = snap.data() || {};
    const bg = data.backgroundImageUrl || null;
    const bv = data.backgroundVideoUrl || null;
    return res.json({ success: true, backgroundImageUrl: bg, backgroundVideoUrl: bv });
  } catch (err) {
    logger.error('fetchConfig failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

/**
 * HTTP function: resetProgress
 * Accepts POST { code }
 * Resets the user's response document `score` to -1 (meaning no questions solved).
 */
exports.resetProgress = onRequest(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'POST required' });
    }
    // Authenticate user via Firebase ID token
    const authHeader = (req.get('Authorization') || req.get('authorization') || '').toString();
    if (!authHeader.startsWith('Bearer ')) {
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Missing Authorization Bearer token' });
    }
    const idToken = authHeader.split('Bearer ')[1].trim();
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      logger.warn('resetProgress: token verification failed', err);
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Invalid auth token' });
    }

    // Reset progress for this user
    const progressRef = admin.firestore().collection('comic_game').doc(USER_PROGRESS_DOC).collection(USER_PROGRESS_SUBCOL).doc(uid);
    const snap = await progressRef.get();
    if (!snap.exists) {
      // create with default progressIndex -1
      await progressRef.set({ progressIndex: -1 });
      return res.json({ success: true });
    }
    await progressRef.update({ progressIndex: -1 });
    return res.json({ success: true });
  } catch (err) {
    logger.error('resetProgress failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

/**
 * HTTP function: submitAnswer
 * Accepts POST with JSON { code, questionSetId, questionId, answer }
 * Behavior:
 *  - finds the user's response doc by code inside games/{COMIC_GAME_ID}/responses
 *  - loads the question set document from comic_game/questions/sets/{questionSetId}
 *  - finds the question by id inside the set and compares the provided answer
 *  - if correct: increments the `score` field on the response doc (atomic increment)
 *  - returns JSON { success: true, correct: true/false }
 */
exports.submitAnswer = onRequest(async (req, res) => {
  try {
    // handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      return res.status(204).send('');
    }
    setCorsHeaders(res);
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'POST required' });
    }

    const body = req.body || {};
    const setId = String(body.questionSetId || '').trim();
    const questionId = String(body.questionId || '').trim();
    const answer = String(body.answer || '').trim();

    if (!setId || !questionId) {
      return res.status(400).json({ success: false, message: 'Missing questionSetId or questionId' });
    }

    // Authenticate user via Firebase ID token
    const authHeader = (req.get('Authorization') || req.get('authorization') || '').toString();
    if (!authHeader.startsWith('Bearer ')) {
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Missing Authorization Bearer token' });
    }
    const idToken = authHeader.split('Bearer ')[1].trim();
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      logger.warn('submitAnswer: token verification failed', err);
      setCorsHeaders(res);
      return res.status(401).json({ success: false, message: 'Invalid auth token' });
    }

    // load question set doc
    const setsRef = admin.firestore().collection('comic_game').doc('questions').collection('sets');
    const setRef = setsRef.doc(setId);
    const setSnap = await setRef.get();
    if (!setSnap.exists) {
      return res.status(404).json({ success: false, message: 'Question set not found' });
    }

    const setData = setSnap.data() || {};
    const questions = Array.isArray(setData.questions) ? setData.questions : [];
    const question = questions.find((q) => String(q.id || q._id || q.questionId || '').trim() === questionId);
    if (!question) {
      return res.status(404).json({ success: false, message: 'Question not found in set' });
    }

    const correctAnsRaw = String(question.answer || question.correct || '').trim();
    const normalizedGiven = answer.trim().toLowerCase();
    const normalizedCorrect = correctAnsRaw.trim().toLowerCase();
    const isCorrect = normalizedGiven.length > 0 && normalizedGiven === normalizedCorrect;

    if (isCorrect) {
      // Determine the frame index that references this question set.
      const framesRef = admin.firestore().collection('comic_game').doc('frames').collection('frames');
      const frameSnap = await framesRef.where('questionSetId', '==', setId).orderBy('index').limit(1).get();
      if (frameSnap.empty) {
        logger.warn('submitAnswer: no frame references setId', setId);
      } else {
        const frameDoc = frameSnap.docs[0];
        const frameData = frameDoc.data() || {};
        const frameIndex = Number(frameData.index);
        if (Number.isNaN(frameIndex)) {
          logger.warn('submitAnswer: frame index is not a number', frameData);
        } else {
          // Update user's progress document at comic_game/user_progress/users/{uid}
          const progressRef = admin.firestore().collection('comic_game').doc(USER_PROGRESS_DOC).collection(USER_PROGRESS_SUBCOL).doc(uid);
          await admin.firestore().runTransaction(async (tx) => {
            const r = await tx.get(progressRef);
            let currentIndex = -1;
            if (r.exists) {
              const d = r.data() || {};
              const raw = Object.prototype.hasOwnProperty.call(d, 'progressIndex') ? d.progressIndex : null;
              if (raw !== undefined && raw !== null) {
                const n = Number(raw);
                if (!Number.isNaN(n)) currentIndex = Math.floor(n);
              }
            }
            if (frameIndex > currentIndex) {
              tx.set(progressRef, { progressIndex: frameIndex }, { merge: true });
            }
          });
        }
      }
    }

    return res.json({ success: true, correct: isCorrect });
  } catch (err) {
    logger.error('submitAnswer failed', err);
    setCorsHeaders(res);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

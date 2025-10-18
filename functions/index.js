/**
 * Cloud Functions for Coders Cup Minigames - comic game helpers
 */

const { setGlobalOptions } = require('firebase-functions');
const { onRequest } = require('firebase-functions/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();

// CONFIGURATION: set your comic game id here. The user said they'll set this manually.
const COMIC_GAME_ID = 'PuNpV5UjO1EQ4qBFXOhL';
// How many frames to return after the user's last solved question
const N_FRAMES = 10; // <-- change this if you want a different hardcoded value

/**
 * HTTP function: getNextFrames
 * Accepts: POST or GET with JSON/query param { code: string }
 * Behavior:
 *  - searches for the response document with the provided `code` inside
 *    games/{COMIC_GAME_ID}/responses
 *  - reads the user's `score` field (assumed numeric).
 *    We interpret solvedQuestions = Math.floor(score) || 0.
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
    const code = (req.method === 'GET') ? (req.query.code || '') : (req.body && req.body.code) || '';
    if (!code || String(code).trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Missing code parameter' });
    }

    // find response by code inside the specific comic game's responses subcollection
    const responsesRef = admin.firestore()
      .collection('games')
      .doc(COMIC_GAME_ID)
      .collection('responses');

    const docId = String(code).trim();
    const docSnap = await responsesRef.doc(docId).get();
    if (!docSnap.exists) {
      return res.status(404).json({ success: false, message: 'No response found for provided code' });
    }

    // normalize to the shape used later (snap.docs[0])
    const snap = { docs: [docSnap] };

    const respDoc = snap.docs[0];
    const resp = respDoc.data() || {};
    // NEW BEHAVIOR: resp.score now holds the frame index of the last correctly answered question.
    // If missing, treat as -1 so frame 0 is included for new players.
    const rawScore = resp.score;
    let lastAnsweredIndex = -1;
    if (rawScore !== undefined && rawScore !== null) {
      const num = Number(rawScore);
      if (!Number.isNaN(num)) {
        lastAnsweredIndex = Math.floor(num);
      }
    }

    // get frames after the solved index
    const framesRef = admin.firestore()
      .collection('comic_game')
      .doc('frames')
      .collection('frames');

    let framesQuery;
    // include frame 0 when the user has no answered frames (lastAnsweredIndex < 0)
    if (lastAnsweredIndex < 0) {
      framesQuery = framesRef.where('index', '>=', 0).orderBy('index').limit(N_FRAMES);
    } else {
      framesQuery = framesRef.where('index', '>', lastAnsweredIndex).orderBy('index').limit(N_FRAMES);
    }
    const framesSnap = await framesQuery.get();
    const frames = [];
    const questionResults = [];

    // prepare sets collection ref
    const setsRef = admin.firestore().collection('comic_game').doc('questions').collection('sets');

    for (const doc of framesSnap.docs) {
      const frameData = doc.data();
      const frameIndex = frameData.index;

      frames.push({ id: doc.id, ...frameData });

      // New schema: frames now store the question set id directly on the frame document.
      const setIdFromFrame = frameData.questionSetId || frameData.questionSet || frameData.setId || null;
      let setDoc = null;
      let setData = {};

      if (setIdFromFrame) {
        const maybe = await setsRef.doc(String(setIdFromFrame)).get();
        if (maybe.exists) {
          setDoc = maybe;
          setData = maybe.data() || {};
        }
      }

      // Fallback: if no setId on frame or the referenced set doc doesn't exist,
      // try the older behavior (query sets where index == frameIndex).
      if (!setDoc) {
        const setSnap = await setsRef.where('index', '==', frameIndex).limit(1).get();
        if (setSnap.empty) {
          // no set for this frame — include a null placeholder
          questionResults.push({ frameIndex, setId: null, question: null });
          continue;
        }
        setDoc = setSnap.docs[0];
        setData = setDoc.data() || {};
      }
      const questions = Array.isArray(setData.questions) ? setData.questions : [];
      if (questions.length === 0) {
        questionResults.push({ frameIndex, setId: setDoc.id, question: null });
        continue;
      }

      // pick a random question from the set
      const q = questions[Math.floor(Math.random() * questions.length)];
      // normalize question shape
      const questionObj = {
        id: q.id || q._id || null,
        text: q.text || q.question || '',
        imageUrl: q.imageUrl || q.image || q.image_url || null,
      };

      questionResults.push({ frameIndex, setId: setDoc.id, question: questionObj });
    }

    return res.json({ success: true, lastAnsweredIndex, frames, questions: questionResults });
  } catch (err) {
    logger.error('getNextFrames failed', err);
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
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'POST required' });
    }

    const body = req.body || {};
    const code = String(body.code || '').trim();
    const setId = String(body.questionSetId || '').trim();
    const questionId = String(body.questionId || '').trim();
    const answer = String(body.answer || '').trim();

    if (!code || !setId || !questionId) {
      return res.status(400).json({ success: false, message: 'Missing code, questionSetId or questionId' });
    }

    const responsesRef = admin.firestore()
      .collection('games')
      .doc(COMIC_GAME_ID)
      .collection('responses');

    // locate response doc (try doc id first)
    let respDocRef = responsesRef.doc(code);
    let respSnap = await respDocRef.get();
    if (!respSnap.exists) {
      const qSnap = await responsesRef.where('code', '==', code).limit(1).get();
      if (qSnap.empty) {
        return res.status(404).json({ success: false, message: 'Response not found for code' });
      }
      respDocRef = qSnap.docs[0].ref;
      respSnap = qSnap.docs[0];
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
      // We must determine the frame index that references this question set.
      const framesRef = admin.firestore().collection('comic_game').doc('frames').collection('frames');
      // find the earliest frame that references this setId
      const frameSnap = await framesRef.where('questionSetId', '==', setId).orderBy('index').limit(1).get();
      if (frameSnap.empty) {
        // No frame references this set; try fallback by matching index field (deprecated)
        // If no frame found, we won't update the score but still return correct=true
        logger.warn('submitAnswer: no frame references setId', setId);
      } else {
        const frameDoc = frameSnap.docs[0];
        const frameData = frameDoc.data() || {};
        const frameIndex = Number(frameData.index || 0);

        // atomically update response.score to the frameIndex, but only if it's newer (greater)
        await admin.firestore().runTransaction(async (tx) => {
          const r = await tx.get(respDocRef);
          if (!r.exists) {
            throw new Error('Response doc disappeared');
          }
          const currentRaw = r.data().score;
          let currentIndex = -1;
          if (currentRaw !== undefined && currentRaw !== null) {
            const n = Number(currentRaw);
            if (!Number.isNaN(n)) currentIndex = Math.floor(n);
          }
          if (frameIndex > currentIndex) {
            tx.update(respDocRef, { score: frameIndex });
          }
        });
      }
    }

    return res.json({ success: true, correct: isCorrect });
  } catch (err) {
    logger.error('submitAnswer failed', err);
    return res.status(500).json({ success: false, message: 'Internal error', error: String(err) });
  }
});

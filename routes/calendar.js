// routes/calendar.js
const express = require("express");
const admin = require("firebase-admin");

const router = express.Router();

router.get("/:category", async (req, res) => {
  const category = req.params.category.toLowerCase();

  try {
    const doc = await admin.firestore().collection("Calendars").doc(category).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Document non trouvé" });
    }

    const data = doc.data();
    const schedule = data?.schedule || {};
    res.json(schedule);
  } catch (err) {
    console.error("Erreur Firestore:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/delete", async (req, res) => {
  const { category, day, name, startTime } = req.body;

  try {
    const docRef = admin.firestore().collection("Calendars").doc(category);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Document non trouvé" });

    const schedule = doc.data().schedule || {};

    let matchFound = false;

    Object.keys(schedule).forEach((key) => {
      const sessions = schedule[key];
      const updatedSessions = sessions.filter(session => {
        const shouldRemove =
          session.day === day &&
          session.name === name &&
          session.startTime === startTime;
        if (shouldRemove) matchFound = true;
        return !shouldRemove;
      });

      schedule[key] = updatedSessions;
    });

    if (!matchFound) {
      return res.status(404).json({ error: "Session introuvable" });
    }

    await docRef.update({ schedule });

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur Firestore:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ✅ POST /calendar/add
router.post("/add", async (req, res) => {
  const { category, day, name, startTime, endTime, type } = req.body;

  try {
    const docRef = admin.firestore().collection("Calendars").doc(category);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Document non trouvé" });

    const schedule = doc.data().schedule || {};

    let targetKey = Object.keys(schedule).find(key =>
      schedule[key]?.length > 0 && schedule[key][0].day === day
    );

    // Si le jour n'existe pas, on choisit le prochain index numérique
    if (!targetKey) {
      const indices = Object.keys(schedule).map(x => parseInt(x, 10));
      const nextIdx = indices.length ? Math.max(...indices) + 1 : 0;
      targetKey = String(nextIdx);
      schedule[targetKey] = [];
    }

    // Crée la nouvelle session à ajouter
    const newSession = { day, name, startTime, endTime, type };

    // Vérifie qu'elle n'existe pas déjà (selon tes critères)
    const exists = schedule[targetKey].some(
      s =>
        s.day === day &&
        s.name === name &&
        s.startTime === startTime
    );
    if (exists) {
      return res.status(409).json({ error: "Session déjà existante" });
    }

    // Ajoute la nouvelle session
    schedule[targetKey].push(newSession);

    await docRef.update({ schedule });
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur Firestore:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ✅ POST /calendar/update
router.post("/update", async (req, res) => {
  const { category, original, updated } = req.body;

  try {
    const docRef = admin.firestore().collection("Calendars").doc(category);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Document non trouvé" });
    const schedule = doc.data().schedule || {};

    let matchFound = false;
    Object.keys(schedule).forEach((k) => {
      schedule[k] = schedule[k].map(session => {
        if (
          session.day === original.day &&
          session.name === original.name &&
          session.startTime === original.startTime
        ) {
          matchFound = true;
          return { ...session, ...updated }; 
        }
        return session;
      });
    });

    if (!matchFound) return res.status(404).json({ error: "Session introuvable" });

    await docRef.update({ schedule });
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur Firestore:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;

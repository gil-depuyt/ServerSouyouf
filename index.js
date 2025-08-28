require("dotenv").config();
process.env.TZ = "Europe/Paris";
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const horaires = require("./data/male.json");
const calendarRoutes = require("./routes/calendar");
const QR_SECRET = process.env.QR_SECRET;

const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON);
const { match } = require("assert");
// const { parse } = require("path");
// const { type } = require("os");
// const { isAsyncFunction } = require("util/types");
// const { decode } = require("punycode");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const app = express();
app.use(cors());
app.use(bodyParser.json());

function calculerAge(dateStr) {
  const birthDate = new Date(dateStr);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();

  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }

  return age;
}

function findMatchingSession(sessionsToday, nowDate, userType) {
  const parseTime = (timeStr) => {
    const [hours, minutes] = timeStr.split("h").map(Number);
    return hours * 60 + (minutes || 0);
  };

  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

  for (const session of sessionsToday) {
    const start = parseTime(session.startTime) - 20; // tolérance avant
    const end = parseTime(session.endTime) + 30; // tolérance après

    // Vérifie si on est dans la plage horaire
    if (nowMinutes >= start && nowMinutes <= end) {
      // Vérifie type utilisateur si défini sur le cours
      if (
        session.type &&
        session.type.toUpperCase() !== userType.toUpperCase()
      ) {
        continue; // type incompatible → passe au prochain
      }

      return session; // session valide trouvée
    }
  }

  return null; // aucun cours valide trouvé
}

function parseDatePaiement(str) {
  const [datePart, timePart] = str.split(" ");
  const [day, month, year] = datePart.split("/").map(Number);
  const [hours, minutes, seconds] = timePart.split(":").map(Number);

  return new Date(year, month - 1, day, hours, minutes, seconds);
}

function isSubscriptionValid(typePaiement, datePaiement) {
  const payedAt = parseDatePaiement(datePaiement);
  const now = new Date();

  if (typePaiement === "Trimestriel") {
    payedAt.setMonth(payedAt.getMonth() + 3);
  } else if (typePaiement === "Annuel") {
    payedAt.setFullYear(payedAt.getFullYear() + 1);
  }
  return now < payedAt;
}

// Middleware de vérificatoin du token Firebase envoyé dans l'en-tête Authorization
async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ error: "Token manquant ou invalidé" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodeToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodeToken;
    next();
  } catch (error) {
    console.error("Erreur de vérification du token : ", error);
    return res.status(403).send({ error: "Token invalidé ou expiré" });
  }
}

app.use("/calendar", calendarRoutes);

app.post("/createUser", async (req, res) => {
  try {
    const {
      email,
      pw,
      prenom,
      nom,
      sexe,
      dateDeNaissance,
      registreNationale,
      telephone,
      adresse,
      package,
      typePaiement,
      resteApaye,
      datePaiement,
      disciplines,
    } = req.body;

    if (!email || !pw || !prenom || !nom || !sexe || !dateDeNaissance) {
      return res.status(400).send({ error: "Champs requis manquants." });
    }

    const age = calculerAge(dateDeNaissance);
    const isKid = age < 13;

    const userRecord = await admin.auth().createUser({
      email,
      password: pw,
      displayName: `${prenom} ${nom}`,
    });

    const type = isKid
      ? "KIDS"
      : sexe.toUpperCase().startsWith("F")
      ? "FEMALE"
      : "MALE";

    await db.collection("Users").doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      pw,
      prenom,
      nom,
      sexe,
      type: type,
      dateDeNaissance,
      registreNationale,
      telephone,
      adresse,
      package,
      typePaiement,
      datePaiement,
      resteApaye,
      disciplines,
      DateAjout: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).send({ message: "Utilisateur créé" });
  } catch (error) {
    console.error("🔥 Erreur backend :", error);
    res.status(500).send({ error: error.message });
  }
});

app.post("/createNotif", async (req, res) => {
  try {
    const { title, message } = req.body;

    if (typeof title === "undefined" || typeof message === "undefined") {
      console.log(
        "Erreur voici title ",
        title,
        " Erreur voici messsage ",
        message
      );
      return res.status(400).json({ error: "Title and message are required." });
    }

    const notifRef = await db.collection("Notifications").add({
      title,
      message,
      visible: true,
      createdAt: new Date(),
    });

    const usersSnapshot = await db.collection("Users").get();

    const batch = db.batch();

    usersSnapshot.forEach((userDoc) => {
      const userId = userDoc.id;
      const userNotifRef = db
        .collection("Users")
        .doc(userId)
        .collection("notifications")
        .doc(notifRef.id);
      batch.set(userNotifRef, {
        read: false,
        createdAt: new Date(),
      });
    });

    await batch.commit();

    res.status(200).json({ success: true, id: notifRef.id });
  } catch (error) {
    console.error("Erreur ajout notification:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/getUser", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const idToken = authHeader.split("Bearer ")[1].trim();

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const snapshot = await db
      .collection("Users")
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "User not found" });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();
    const userId = userDoc.id;

    const checkinsSnapshot = await db
      .collection("Users")
      .doc(userId)
      .collection("checkins")
      .orderBy("scannedAt", "desc")
      .get();

    const checkins = checkinsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({
      id: userId,
      ...userData,
      checkins,
    });
  } catch (error) {
    console.error("Error in /getUser", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/editUser", async (req, res) => {
  try {
    const user = req.body;
    const {
      uid,
      email,
      prenom,
      nom,
      sexe,
      type,
      dateDeNaissance,
      registreNationale,
      telephone,
      adresse,
      disciplines,
      package,
      typePaiement,
      datePaiement,
      resteApaye,
    } = user;

    if (!uid || !sexe) {
      return res.status(400).json({ error: "Missing uid or sexe" });
    }

    const userDocRef = db.collection("Users").doc(uid);

    const docSnap = await userDocRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // On update le doc trouvé
    await userDocRef.update({
      email,
      prenom,
      nom,
      sexe,
      type,
      dateDeNaissance,
      registreNationale,
      telephone,
      adresse,
      package,
      typePaiement,
      datePaiement,
      disciplines,
      resteApaye,
    });

    return res.status(200).json({ message: "User updated" });
  } catch (error) {
    console.error("Erreur /editUser", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/deleteUser", async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "Missing uid parameter" });
  try {
    const snapshot = await db
      .collection("Users")
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const docRef = snapshot.docs[0].ref;

      // 1. Delete all subcollections
      const subcollections = await docRef.listCollections();
      for (const subcol of subcollections) {
        const docs = await subcol.get();
        for (const doc of docs.docs) {
          await doc.ref.delete();
        }
      }

      // 2. Delete the Firestore document
      await docRef.delete();

      try {
        await admin.auth().deleteUser(uid);
      } catch (err) {
        console.error("Error deleting auth user:", err);
      }

      return res
        .status(200)
        .json({ message: "User and auth deleted" });
    }
    return res.status(404).json({ error: "User not found" });
  } catch (error) {
    console.error("Erreur /deleteUser", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/deleteNotif", async (req, res) => {
  const { uid } = req.query; // uid = ID de la notification

  if (!uid) {
    return res.status(400).json({ error: "Missing uid parameter" });
  }

  try {
    const notifRef = db.collection("Notifications").doc(uid);
    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // 1. Supprimer la notification globale
    await notifRef.delete();

    // 2. Supprimer cette notification de la sous-collection de chaque utilisateur
    const usersSnapshot = await db.collection("Users").get();
    const batch = db.batch();

    usersSnapshot.forEach((userDoc) => {
      const userId = userDoc.id;
      const userNotifRef = db
        .collection("Users")
        .doc(userId)
        .collection("notifications")
        .doc(uid);

      batch.delete(userNotifRef);
    });

    await batch.commit();

    return res
      .status(200)
      .json({ message: "Notification deleted from all users." });
  } catch (error) {
    console.error("Error deleting notification:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/getAllUsers", async (req, res) => {
  try {
    const allUsers = [];

    const snapshot = await db.collection("Users").get();
    snapshot.forEach((doc) => {
      allUsers.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.status(200).json(allUsers);
  } catch (error) {
    console.error("Erreur Firestore:", error);
    res.status(500).send("Erreur interne du serveur");
  }
});

app.get("/getAllNotifications", async (req, res) => {
  try {
    const allNotifications = [];

    const snapshot = await db.collection("Notifications").get();
    snapshot.forEach((doc) => {
      allNotifications.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.status(200).json(allNotifications);
  } catch (error) {
    console.error("Erreur Firestore:", error);
    res.status(500).send("Erreur interne du serveur");
  }
});

app.post("/generate-qr-token", authenticateToken, async (req, res) => {
  const { uid } = req.user;

  const token = jwt.sign(
    {
      uid,
      exp: Math.floor(Date.now() / 1000) + 60 * 5, // 5 minutes
    },
    QR_SECRET
  );

  res.status(200).send({ token });
});

// app.post("/scan-checkin", async (req, res) => {
//   const { token, sessionType, currentTime } = req.body;

//   if (!token) {
//     return res.status(400).send({ error: "QR token manquant" });
//   }

//   try {
//     // verifie le JWT
//     const decoded = jwt.verify(token, QR_SECRET);
//     const { uid, exp } = decoded;

//     if (Date.now() >= exp * 1000) {
//       return res.status(401).send({ error: "QR expiré" });
//     }

//     const userDocRef = db.collection("Users").doc(uid);

//     const docSnap = await userDocRef.get();
//     if (!docSnap.exists) {
//       return res.status(404).json({ error: "User not found" });
//     }

//     //Vérifie les donées utilisateur
//     const userDoc = await userDocRef.get();
//     const userData = userDoc.data();

//     const discipline = (disciplineInfo = userData.disciplines?.[sessionType]);
//     if (!discipline) {
//       return res.status(403).send({ error: "Discipline non souscrite" });
//     }

//     if (discipline === false) {
//       return res.status(403).send({ error: "Accès discipline non autorisé" });
//     }

//     if (!isSubscriptionValid(userData.typePaiement, userData.datePaiement)) {
//       return res.status(403).send({ error: "Abonnement expiré" });
//     }

//     // Vérifie si il a deja scanné
//     const today = new Date().toISOString().split("T")[0];
//     const alreadyScanned = await userDocRef
//       .collection("checkins")
//       .where("date", "==", today)
//       .limit(1)
//       .get();

//     if (!alreadyScanned.empty) {
//       return res.status(409).send({ error: "Deja scanné aujourd'hui" });
//     }

//     // vérifie que le cours est en cours
//     if (!isCoursEnCours(sessionType, currentTime)) {
//       return res.status(403).send({ error: "Hors créneau du cours " });
//     }

//     // enregistre la présence
//     await userDocRef.collection("checkins").add({
//       date: today,
//       scannedAt: admin.firestore.FieldValue.serverTimestamp(),
//       sessionType: sessionType,
//     });

//     res.status(200).send({ message: "Présence enregistrée !" });
//   } catch (error) {
//     console.error("Erreur QR checkin: ", error);
//     res.status(400).send({ error: "QR invalide ou expiré" });
//   }
// });

app.post("/scan-checkin", async (req, res) => {
  const { token, currentTime } = req.body;

  if (!token) {
    return res.status(400).send({ error: "QR token manquant" });
  }

  try {
    const decoded = jwt.verify(token, QR_SECRET);
    const { uid, exp } = decoded;

    if (Date.now() >= exp * 1000) {
      return res.status(401).send({ error: "QR expiré" });
    }

    const userDocRef = db.collection("Users").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }
    const userData = userDoc.data();

    const category = userData.type?.toLowerCase();
    if (!category) {
      return res.status(400).json({ error: "Catégorie utilisateur inconnue" });
    }

    // Charge planning du jour
    const calendarDoc = await db.collection("Calendars").doc(category).get();
    if (!calendarDoc.exists) {
      return res.status(404).json({ error: "Planning introuvable" });
    }
    const schedule = calendarDoc.data().schedule || {};
    const dayIndex = new Date(currentTime || Date.now()).getDay().toString();
    const sessionsToday = schedule[dayIndex] || [];

    // Trouve cours matching
    const nowDate = new Date(currentTime || Date.now());
    const matchedSession = findMatchingSession(
      sessionsToday,
      nowDate,
      userData.type
    );

    if (!matchedSession) {
      return res
        .status(403)
        .send({ error: matchedSession + "Aucun cours actif ou proche dans votre planning" });
    }

    // Vérifie la discipline/payement
    const discipline = userData.disciplines?.[matchedSession.name];
    if (!discipline) {
      return res.status(403).send({ error: "Discipline non souscrite" });
    }
    if (discipline === false) {
      return res.status(403).send({ error: "Accès discipline non autorisé" });
    }
    if (!isSubscriptionValid(userData.typePaiement, userData.datePaiement)) {
      return res.status(403).send({ error: "Abonnement expiré" });
    }

    // Vérifie si dernier check-in < 2 heures
    const twoHoursAgo = new Date(nowDate.getTime() - 2 * 60 * 60 * 1000);

    const recentCheckins = await userDocRef
      .collection("checkins")
      .where("scannedAt", ">", twoHoursAgo)
      .limit(1)
      .get();

    if (!recentCheckins.empty) {
      return res.status(409).send({ error: "Déjà scanné il y a moins de 2 heures" });
    }

    // Enregistre le check-in
    await userDocRef.collection("checkins").add({
      date: new Date().toISOString().split("T")[0],
      scannedAt: admin.firestore.FieldValue.serverTimestamp(),
      sessionType: matchedSession.name,
    });

    res.status(200).send({ message: "Présence enregistrée !" });
  } catch (error) {
    console.error("Erreur lors du scan-checkin:", error);
    res.status(400).send({ error: "QR invalide ou expiré" });
  }
});


//PAS SUR DE GARDER
app.get("/scan-status/:uid", async (req, res) => {
  const { uid } = req.params;
  const today = new Date().toISOString().split("T")[0];

  try {
    let userDocRef = null;

    const snapshot = await db
      .collection("Users")
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      userDocRef = snapshot.docs[0].ref;
    }

    if (!userDocRef) {
      return res.status(404).send({ error: "Utilisateur introuvable" });
    }

    // Vérifier dans la sous-collection checkins s'il y a un checkin aujourd'hui
    const checkinsSnapshot = await userDocRef
      .collection("checkins")
      .where("date", "==", today)
      .limit(1)
      .get();

    return res.status(200).send({
      scannedToday: !checkinsSnapshot.empty,
    });
  } catch (err) {
    console.error("Erreur /scan-status:", err);
    res.status(500).send({ error: "Erreur serveur" });
  }
});

//PAS SUR DE GARDER
app.get("/user-stats/:uid", async (req, res) => {
  const { uid } = req.params;
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthString = firstDay.toISOString().split("T")[0];

  try {
    let userDocRef = null;

    const snapshot = await db
      .collection("Users")
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      userDocRef = snapshot.docs[0].ref;
    }

    if (!userDocRef) {
      return res.status(404).send({ error: "Utilisateur introuvable" });
    }

    // Récupérer les checkins du mois
    const checkinsSnapshot = await userDocRef
      .collection("checkins")
      .where("date", ">=", monthString)
      .get();

    const sessions = checkinsSnapshot.docs.map((doc) => doc.data());

    // Compter par type de session
    const sessionTypes = {};
    sessions.forEach((s) => {
      sessionTypes[s.sessionType] = (sessionTypes[s.sessionType] || 0) + 1;
    });

    // Trouver la dernière session
    const last = sessions.length
      ? sessions.sort(
          (a, b) =>
            new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime()
        )[0]
      : null;

    res.status(200).send({
      totalThisMonth: sessions.length,
      lastCheckin: last ? last.scannedAt : null,
      byType: sessionTypes,
    });
  } catch (err) {
    console.error("Erreur /user-stats:", err);
    res.status(500).send({ error: "Erreur stats utilisateur" });
  }
});

app.get("/secure", authenticateToken, async (req, res) => {
  const uid = req.user.uid; // uid de l'utilisateur connecté
  res.status(200).send({ message: `Bienvenue, utilisateur ${uid}` });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 API backend en écoute sur http://localhost:${PORT}`);
});

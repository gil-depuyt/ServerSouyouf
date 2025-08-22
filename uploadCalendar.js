const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function uploadCalendar(type) {
  const filePath = path.join(__dirname, 'data', `${type}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const schedule = JSON.parse(raw);
  await db.collection('Calendars').doc(type).set({ schedule });
  console.log(`✅ Planning ${type} uploadé`);
}

async function main() {
  try {
    await uploadCalendar('kids');
    console.log('🚀 Tous les plannings ont été uploadés');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur lors de l’upload :', error);
    process.exit(1);
  }
}

main();
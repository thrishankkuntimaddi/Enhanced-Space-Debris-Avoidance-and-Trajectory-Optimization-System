// src/interface/static/js/firebase.js
// Firebase v9+ modular SDK via CDN compat shim
// Loaded as a module in all pages.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
import {
    getFirestore,
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyALUloNt0HWTMeP4IARvRMS9JY-R5_NnFM",
    authDomain: "nistha-passi-core.firebaseapp.com",
    projectId: "nistha-passi-core",
    storageBucket: "nistha-passi-core.firebasestorage.app",
    messagingSenderId: "299692286010",
    appId: "1:299692286010:web:c7a8c37a680d7637aa5503",
    measurementId: "G-87R8Y3FNT9"
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const analytics   = getAnalytics(firebaseApp);
const db          = getFirestore(firebaseApp);

// ── Helpers exported to other scripts ────────────────────────────────────────

/**
 * Log a named analytics event.
 * @param {string} eventName
 * @param {Object} params
 */
export function trackEvent(eventName, params = {}) {
    logEvent(analytics, eventName, params);
}

/**
 * Save a mission session record to Firestore.
 * @param {Object} sessionData  – { rocketType, orbitType, altitudeKm, collisions, status }
 * @returns {Promise<string>}   – document ID
 */
export async function saveMissionSession(sessionData) {
    try {
        const ref = await addDoc(collection(db, "mission_sessions"), {
            ...sessionData,
            createdAt: serverTimestamp()
        });
        console.log("[Firebase] Session saved:", ref.id);
        return ref.id;
    } catch (err) {
        console.error("[Firebase] Failed to save session:", err);
    }
}

// Auto-track page views
trackEvent("page_view", { page_path: window.location.pathname });

// src/interface/static/js/script.js
import { trackEvent, saveMissionSession } from './firebase.js';

// ── Splash page ───────────────────────────────────────────────────────────────
function createStars() {
    for (let i = 0; i < 250; i++) {
        const star = document.createElement('div');
        star.classList.add('star');
        star.style.left = `${Math.random() * 100}vw`;
        star.style.top  = `${Math.random() * 100}vh`;
        document.body.appendChild(star);
    }
    for (let i = 0; i < 100; i++) {
        const star = document.createElement('div');
        star.classList.add('bstar');
        star.style.left = `${Math.random() * 100}vw`;
        star.style.top  = `${Math.random() * 100}vh`;
        document.body.appendChild(star);
    }
}

// Helper: safely attach listener only when element exists
function on(id, event, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
}

// ── Index (splash) page ───────────────────────────────────────────────────────
if (document.getElementById('startBtn')) {
    createStars();
    setTimeout(() => {
        const earth   = document.getElementById('earth');
        const welcome = document.getElementById('welcome');
        if (earth)   earth.style.display   = 'block';
        if (welcome) welcome.style.display = 'block';
    }, 1700);
    trackEvent('splash_view');
}

// ── Input page ────────────────────────────────────────────────────────────────

// Toggle sections
on('upload-btn', 'click', () => {
    document.getElementById('upload-section').classList.remove('hidden');
    document.getElementById('paste-section').classList.add('hidden');
    document.getElementById('tle-instructions-popup').classList.add('hidden');
});

on('paste-btn', 'click', () => {
    document.getElementById('paste-section').classList.remove('hidden');
    document.getElementById('upload-section').classList.add('hidden');
    document.getElementById('tle-instructions-popup').classList.add('hidden');
});

// Upload flow
on('preprocess-upload', 'click', () => {
    const file = document.getElementById('file-upload').files[0];
    if (!file) return alert('Please upload a TLE file first.');
    const formData = new FormData();
    formData.append('file', file);
    fetch('/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            alert(data.message);
            document.getElementById('step2').classList.remove('hidden');
            loadTimestamps();
            trackEvent('tle_uploaded', { method: 'file' });
        })
        .catch(err => alert('Upload failed: ' + err));
});

// Paste flow
on('preprocess-paste', 'click', () => {
    const tleText = document.getElementById('tle-text').value.trim();
    if (!tleText) return alert('Please paste some TLE data first.');
    if (!tleText.includes('1 ') || !tleText.includes('2 ')) {
        return alert('Invalid TLE format—needs "1 " and "2 " lines.');
    }
    fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tleText })
    })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert('Error: ' + data.error); return; }
            alert(data.message);
            document.getElementById('step2').classList.remove('hidden');
            loadTimestamps();
            trackEvent('tle_uploaded', { method: 'paste' });
        })
        .catch(err => alert('Paste failed: ' + err));
});

// Popup
on('how-to-btn', 'click', () =>
    document.getElementById('tle-instructions-popup').classList.remove('hidden'));
on('close-popup', 'click', () =>
    document.getElementById('tle-instructions-popup').classList.add('hidden'));

// Timestamp
function loadTimestamps() {
    fetch('/get_timestamps')
        .then(r => r.json())
        .then(data => {
            const rangeDisplay = document.getElementById('timestamp-range');
            if (rangeDisplay) rangeDisplay.textContent = `Valid range: ${data.min} to ${data.max}`;
            const ts = document.getElementById('timestamp');
            if (ts) { ts.dataset.min = data.min; ts.dataset.max = data.max; }
        })
        .catch(err => alert('Error loading timestamps: ' + err));
}

on('confirm-timestamp', 'click', () => {
    const input       = document.getElementById('timestamp');
    const userInput   = input.value.trim();
    const minTime     = new Date(input.dataset.min.replace(/\//g, '-'));
    const maxTime     = new Date(input.dataset.max.replace(/\//g, '-'));
    let selectedTime;

    if (!userInput) {
        selectedTime = input.dataset.min;
    } else {
        try {
            const parsed = new Date(userInput.replace(/\//g, '-'));
            if (isNaN(parsed.getTime())) throw new Error('Invalid format');
            if (parsed < minTime || parsed > maxTime) {
                alert(`Timestamp must be between ${input.dataset.min} and ${input.dataset.max}`);
                return;
            }
            selectedTime = userInput;
        } catch (e) {
            alert('Invalid format. Use YYYY/MM/DD HH:MM:SS (e.g., 2024/06/06 05:11:42)');
            return;
        }
    }

    document.getElementById('selected-timestamp').textContent = selectedTime;
    document.getElementById('timestamp-confirm').classList.remove('hidden');
    document.getElementById('step3').classList.remove('hidden');
    updateAltitudeRange();
    trackEvent('timestamp_selected');
});

// Orbit
function updateAltitudeRange() {
    const orbitType    = document.getElementById('orbit-type').value;
    const ranges       = {
        LEO: { min: 200,   max: 2000,  text: '200-2000 km'    },
        MEO: { min: 2000,  max: 35786, text: '2000-35786 km'  },
        GEO: { min: 35786, max: 35786, text: '35786 km (Fixed)'},
        HEO: { min: 35787, max: 50000, text: '35787-50000 km' }
    };
    const range        = ranges[orbitType];
    const altitudeInput = document.getElementById('target-altitude');
    const rangeLabel   = document.getElementById('altitude-range');

    if (rangeLabel) {
        rangeLabel.textContent = orbitType === 'GEO'
            ? 'Fixed at 35786 km'
            : `Enter target altitude between ${range.text}`;
    }
    if (altitudeInput) {
        if (orbitType === 'GEO') { altitudeInput.value = 35786; altitudeInput.disabled = true; }
        else                     { altitudeInput.value = '';    altitudeInput.disabled = false; }
    }
}

on('orbit-type', 'change', updateAltitudeRange);

on('confirm-orbit', 'click', () => {
    const orbitType    = document.getElementById('orbit-type').value;
    const altitudeInput = document.getElementById('target-altitude');
    const altitude     = orbitType === 'GEO' ? 35786 : parseFloat(altitudeInput.value);
    const ranges       = { LEO: [200, 2000], MEO: [2000, 35786], GEO: [35786, 35786], HEO: [35787, 50000] };
    const [min, max]   = ranges[orbitType];

    if (isNaN(altitude) || altitude < min || altitude > max) {
        alert(`Altitude for ${orbitType} must be between ${min} and ${max} km`);
        return;
    }

    document.getElementById('selected-orbit').textContent   = orbitType;
    document.getElementById('selected-altitude').textContent = altitude;
    document.getElementById('orbit-confirm').classList.remove('hidden');

    fetch('/get_rockets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orbitType, targetAltitude: altitude })
    })
        .then(r => r.json())
        .then(data => {
            const select = document.getElementById('rocket-select');
            select.innerHTML = '<option value="">-- Select Rocket --</option>';
            data.forEach((rocket, i) => {
                select.innerHTML += `<option value="${i}">${rocket.Rocket_Type} - ${rocket.Launch_Site}</option>`;
            });
            document.getElementById('step4').classList.remove('hidden');
            trackEvent('orbit_selected', { orbitType, altitude });
        })
        .catch(err => alert('Error loading rockets: ' + err));
});

// Rocket + trajectory
on('calculate', 'click', () => {
    const rocketIndex = document.getElementById('rocket-select').value;
    if (!rocketIndex) return alert('Please select a rocket.');

    const orbitType  = document.getElementById('orbit-type').value;
    const altitude   = parseFloat(document.getElementById('target-altitude').value);
    const timestamp  = document.getElementById('timestamp').value;

    fetch('/get_rockets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orbitType, targetAltitude: altitude })
    })
        .then(r => r.json())
        .then(data => {
            const rocket  = data[rocketIndex];
            const payload = {
                rocketType:             rocket.Rocket_Type,
                launchSite:             rocket.Launch_Site,
                launchSiteCoordinates:  rocket.Launch_Site_Coordinates,
                targetAltitude:         altitude,
                orbitType,
                timestamp
            };

            document.getElementById('selected-rocket').textContent = `${rocket.Rocket_Type} from ${rocket.Launch_Site}`;
            document.getElementById('rocket-confirm').classList.remove('hidden');
            document.getElementById('step5').classList.remove('hidden');
            document.getElementById('processing').classList.remove('hidden');

            const processingStep = document.getElementById('processing-step');
            trackEvent('trajectory_started', { rocketType: rocket.Rocket_Type, orbitType, altitude });

            fetch('/process_trajectory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP error! Status: ${r.status}`);
                    return r.json();
                })
                .then(async data => {
                    if (data.error) throw new Error(data.error);

                    // Save to Firestore
                    await saveMissionSession({
                        rocketType:  rocket.Rocket_Type,
                        orbitType,
                        altitudeKm:  altitude,
                        collisions:  data.collisions,
                        status:      'complete'
                    });
                    trackEvent('trajectory_complete', { collisions: data.collisions });

                    let stepIndex = 0;
                    const steps   = data.steps;
                    function showNextStep() {
                        if (stepIndex < steps.length) {
                            processingStep.textContent = steps[stepIndex++] + ' 🚀';
                            setTimeout(showNextStep, 1000);
                        } else {
                            document.getElementById('processing').classList.add('hidden');
                            window.open(data.viz_url, '_blank');
                            window.location.href = `/report?report_content=${encodeURIComponent(data.report_content)}`;
                        }
                    }
                    showNextStep();
                })
                .catch(err => {
                    document.getElementById('processing').classList.add('hidden');
                    alert(`Error processing trajectory: ${err.message}`);
                    console.error('Fetch error:', err);
                    trackEvent('trajectory_error', { error: err.message });
                });
        });
});
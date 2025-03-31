function createStars() {
    for (let i = 0; i < 250; i++) {
        const star = document.createElement('div');
        star.classList.add('star');
        star.style.left = `${Math.random() * 100}vw`;
        star.style.top = `${Math.random() * 100}vh`;
        document.body.appendChild(star);
    }
    for (let i = 0; i < 100; i++) {
        const star = document.createElement('div');
        star.classList.add('bstar');
        star.style.left = `${Math.random() * 100}vw`;
        star.style.top = `${Math.random() * 100}vh`;
        document.body.appendChild(star);
    }
}

if (document.getElementById('startBtn')) {
    createStars();
    setTimeout(() => {
        document.getElementById('earth').style.display = 'block';
        document.getElementById('welcome').style.display = 'block';
    }, 1700);
    document.getElementById('startBtn').addEventListener('click', () => {
        window.location.href = '/input_page';
    });
}

// Toggle sections
document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('upload-section').classList.remove('hidden');
    document.getElementById('paste-section').classList.add('hidden');
    document.getElementById('tle-instructions-popup').classList.add('hidden');
});

document.getElementById('paste-btn').addEventListener('click', () => {
    document.getElementById('paste-section').classList.remove('hidden');
    document.getElementById('upload-section').classList.add('hidden');
    document.getElementById('tle-instructions-popup').classList.add('hidden');
});

// Upload flow
document.getElementById('preprocess-upload').addEventListener('click', () => {
    const file = document.getElementById('file-upload').files[0];
    if (!file) return alert('Please upload a TLE file first.');
    const formData = new FormData();
    formData.append('file', file);
    fetch('/upload', { method: 'POST', body: formData })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                alert('Error: ' + data.error);
            } else {
                alert(data.message); // "TLE processed successfully"
                // document.getElementById('upload-section').classList.add('hidden');
                document.getElementById('step2').classList.remove('hidden');
                loadTimestamps(); // Your existing function
            }
        })
        .catch(error => alert('Upload failed: ' + error));
});

// Paste flow
document.getElementById('preprocess-paste').addEventListener('click', () => {
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
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                alert('Error: ' + data.error);
            } else {
                alert(data.message); // "TLE text saved and processed successfully"
                // Don’t hide paste-section—keep it visible
                document.getElementById('step2').classList.remove('hidden');
                loadTimestamps(); // Move to Step 2, keep paste section up
            }
        })
        .catch(error => alert('Paste failed: ' + error));
});

// Popup logic
document.getElementById('how-to-btn').addEventListener('click', () => {
    document.getElementById('tle-instructions-popup').classList.remove('hidden');
});

document.getElementById('close-popup').addEventListener('click', () => {
    document.getElementById('tle-instructions-popup').classList.add('hidden');
});

function loadTimestamps() {
    fetch('/get_timestamps')
        .then(response => response.json())
        .then(data => {
            const rangeDisplay = document.getElementById('timestamp-range');
            rangeDisplay.textContent = `Valid range: ${data.min} to ${data.max}`;
            document.getElementById('timestamp').dataset.min = data.min;
            document.getElementById('timestamp').dataset.max = data.max;
        })
        .catch(error => alert('Error loading timestamps: ' + error));
}

document.getElementById('confirm-timestamp').addEventListener('click', () => {
    const input = document.getElementById('timestamp');
    const userInput = input.value.trim();
    const minTime = new Date(input.dataset.min.replace(/\//g, '-'));
    const maxTime = new Date(input.dataset.max.replace(/\//g, '-'));
    let selectedTime;

    if (!userInput) {
        selectedTime = input.dataset.min; // Default to min
    } else {
        try {
            selectedTime = new Date(userInput.replace(/\//g, '-'));
            if (isNaN(selectedTime.getTime())) throw new Error("Invalid format");
            if (selectedTime < minTime || selectedTime > maxTime) {
                alert(`Timestamp must be between ${input.dataset.min} and ${input.dataset.max}`);
                return;
            }
            selectedTime = userInput; // Keep original format
        } catch (e) {
            alert('Invalid format. Use YYYY/MM/DD HH:MM:SS (e.g., 2024/06/06 05:11:42)');
            return;
        }
    }

    // Show confirmation
    document.getElementById('selected-timestamp').textContent = selectedTime;
    document.getElementById('timestamp-confirm').classList.remove('hidden');
    console.log("Selected timestamp:", selectedTime); // Debug
    document.getElementById('step3').classList.remove('hidden');
    updateAltitudeRange();
});

function updateAltitudeRange() {
    const orbitType = document.getElementById('orbit-type').value;
    const ranges = {
        LEO: { min: 200, max: 2000, text: '200-2000 km' },
        MEO: { min: 2000, max: 35786, text: '2000-35786 km' },
        GEO: { min: 35786, max: 35786, text: '35786 km (Fixed)' },
        HEO: { min: 35787, max: 50000, text: '35787-50000 km' }
    };
    const range = ranges[orbitType];
    const altitudeInput = document.getElementById('target-altitude');

    document.getElementById('altitude-range').textContent =
        orbitType === 'GEO' ? 'Fixed at 35786 km' : `Enter target altitude between ${range.text}`;

    if (orbitType === 'GEO') {
        altitudeInput.value = 35786;
        altitudeInput.disabled = true;
    } else {
        altitudeInput.value = '';
        altitudeInput.disabled = false;
    }
}

// Trigger on load and change
document.getElementById('orbit-type').addEventListener('change', updateAltitudeRange);
// Call it from timestamp confirm too
function updateAltitudeRangeOnStep3() {
    updateAltitudeRange();
}

document.getElementById('confirm-orbit').addEventListener('click', () => {
    const orbitType = document.getElementById('orbit-type').value;
    const altitudeInput = document.getElementById('target-altitude');
    const altitude = orbitType === 'GEO' ? 35786 : parseFloat(altitudeInput.value);
    const ranges = {
        LEO: [200, 2000],
        MEO: [2000, 35786],
        GEO: [35786, 35786],
        HEO: [35787, 50000]
    };
    const [min, max] = ranges[orbitType];

    if (isNaN(altitude) || altitude < min || altitude > max) {
        alert(`Altitude for ${orbitType} must be between ${min} and ${max} km`);
        return;
    }

    // Show confirmation
    document.getElementById('selected-orbit').textContent = orbitType;
    document.getElementById('selected-altitude').textContent = altitude;
    document.getElementById('orbit-confirm').classList.remove('hidden');

    fetch('/get_rockets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orbitType, targetAltitude: altitude })
    })
    .then(response => response.json())
    .then(data => {
        const select = document.getElementById('rocket-select');
        select.innerHTML = '<option value="">-- Select Rocket --</option>';
        data.forEach((rocket, i) => {
            select.innerHTML += `<option value="${i}">${rocket.Rocket_Type} - ${rocket.Launch_Site}</option>`;
        });
        document.getElementById('step4').classList.remove('hidden');
    })
    .catch(error => alert('Error loading rockets: ' + error));
});

document.getElementById('calculate').addEventListener('click', () => {
    const rocketIndex = document.getElementById('rocket-select').value;
    if (!rocketIndex) return alert('Please select a rocket.');

    fetch('/get_rockets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            orbitType: document.getElementById('orbit-type').value,
            targetAltitude: parseFloat(document.getElementById('target-altitude').value)
        })
    })
    .then(response => response.json())
    .then(data => {
        const rocket = data[rocketIndex];
        const payload = {
            rocketType: rocket.Rocket_Type,
            launchSite: rocket.Launch_Site,
            launchSiteCoordinates: rocket.Launch_Site_Coordinates,
            targetAltitude: parseFloat(document.getElementById('target-altitude').value),
            orbitType: document.getElementById('orbit-type').value,
            timestamp: document.getElementById('timestamp').value
        };

        document.getElementById('selected-rocket').textContent = `${rocket.Rocket_Type} from ${rocket.Launch_Site}`;
        document.getElementById('rocket-confirm').classList.remove('hidden');

        document.getElementById('step5').classList.remove('hidden');
        document.getElementById('processing').classList.remove('hidden');
        const processingStep = document.getElementById('processing-step');

        fetch('/process_trajectory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (data.error) {
                throw new Error(data.error);
            }
            let stepIndex = 0;
            const steps = data.steps;
            function showNextStep() {
                if (stepIndex < steps.length) {
                    processingStep.textContent = steps[stepIndex] + " 🚀";
                    stepIndex++;
                    setTimeout(showNextStep, 1000);
                } else {
                    document.getElementById('processing').classList.add('hidden');
                    window.open(data.viz_url, '_blank');
                    window.location.href = `/report?report_content=${encodeURIComponent(data.report_content)}`;
                }
            }
            showNextStep();
        })
        .catch(error => {
            document.getElementById('processing').classList.add('hidden');
            alert(`Error processing trajectory: ${error.message}`);
            console.error('Fetch error:', error);
        });
    });
});
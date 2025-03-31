// dummy.js

// Step 1: Timestamp Selection
function loadTimestamps() {
    const now = new Date();
    const minDate = new Date(now);
    const maxDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const formatDate = (date) => {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        const h = String(date.getUTCHours()).padStart(2, '0');
        const min = String(date.getUTCMinutes()).padStart(2, '0');
        const s = String(date.getUTCSeconds()).padStart(2, '0');
        return `${y}/${m}/${d} ${h}:${min}:${s}`;
    };

    const min = formatDate(minDate);
    const max = formatDate(maxDate);

    document.getElementById('timestamp-range').textContent = `Valid range: ${min} to ${max}`;
    document.getElementById('timestamp').dataset.min = min;
    document.getElementById('timestamp').dataset.max = max;
}

loadTimestamps(); // Run on load

document.getElementById('confirm-timestamp').addEventListener('click', () => {
    const input = document.getElementById('timestamp');
    const userInput = input.value.trim();
    const regex = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!regex.test(userInput)) {
        alert('Please use format YYYY/MM/DD HH:MM:SS');
        return;
    }

    const selectedDate = new Date(userInput.replace(/\//g, '-'));
    const minDate = new Date(input.dataset.min.replace(/\//g, '-'));
    const maxDate = new Date(input.dataset.max.replace(/\//g, '-'));

    if (isNaN(selectedDate.getTime()) || selectedDate < minDate || selectedDate > maxDate) {
        alert(`Timestamp must be between ${input.dataset.min} and ${input.dataset.max}`);
        return;
    }

    document.getElementById('selected-timestamp').textContent = userInput;
    document.getElementById('timestamp-confirm').classList.remove('hidden');
    document.getElementById('step2').classList.remove('hidden');
});

// Step 2: Orbit Selection
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

document.getElementById('orbit-type').addEventListener('change', updateAltitudeRange);

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

    document.getElementById('selected-orbit').textContent = orbitType;
    document.getElementById('selected-altitude').textContent = altitude;
    document.getElementById('orbit-confirm').classList.remove('hidden');
    document.getElementById('step3').classList.remove('hidden');

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
        })
        .catch(error => alert('Error loading rockets: ' + error));
});

// Step 3: Rocket Selection & Initial Trajectory
document.getElementById('calculate-initial').addEventListener('click', () => {
    const rocketIndex = document.getElementById('rocket-select').value;
    if (!rocketIndex) {
        alert('Please select a rocket.');
        return;
    }

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

            fetch('/dummy_initial_trajectory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
                .then(response => response.json())
                .then(data => {
                    if (data.error) throw new Error(data.error);
                    document.getElementById('trajectory-confirm').classList.remove('hidden');
                    document.getElementById('step4').classList.remove('hidden');
                })
                .catch(error => alert('Error calculating trajectory: ' + error));
        })
        .catch(error => alert('Error fetching rocket details: ' + error));
});

// Step 4: Generate Collision-Prone Dummy TLEs & Process
document.getElementById('generate-btn').addEventListener('click', () => {
    const debrisCount = document.getElementById('debris-count').value;
    if (!debrisCount || debrisCount < 5 || debrisCount > 100) {
        alert('Please enter a number between 5 and 100.');
        return;
    }

    const rocketIndex = document.getElementById('rocket-select').value;
    if (!rocketIndex) {
        alert('Please select a rocket first.');
        return;
    }

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
                count: parseInt(debrisCount),
                timestamp: document.getElementById('timestamp').value,
                targetAltitude: parseFloat(document.getElementById('target-altitude').value),
                orbitType: document.getElementById('orbit-type').value,
                rocketType: rocket.Rocket_Type,
                launchSiteCoordinates: rocket.Launch_Site_Coordinates
            };

            fetch('/generate_dummy_tles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
                .then(response => response.json())
                .then(data => {
                    if (data.error) throw new Error(data.error);
                    document.getElementById('generated-count').textContent = debrisCount;
                    document.getElementById('generate-confirm').classList.remove('hidden');
                    document.getElementById('step5').classList.remove('hidden');

                    // Process collisions and optimization
                    fetch('/process_dummy_trajectory', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    })
                        .then(response => {
                            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                            return response.json();
                        })
                        .then(data => {
                            if (data.error) throw new Error(data.error);
                            const processingStep = document.getElementById('processing-step');
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
                            document.getElementById('processing').classList.remove('hidden');
                            showNextStep();
                        })
                        .catch(error => {
                            document.getElementById('processing').classList.add('hidden');
                            alert(`Error processing trajectory: ${error.message}`);
                        });
                })
                .catch(error => alert('Generation failed: ' + error.message));
        })
        .catch(error => alert('Error fetching rocket details: ' + error));
});
// ============ ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ============
let map;
let clusterGroup;
let heatLayer;
let currentView = 'markers';
let allMeasurements = [];

// Шумомер
let mediaStream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let currentDB = 0;
let isMeterActive = false;

// Ручной ввод
let manualDb = null;

// Геолокация
let currentLat = null, currentLng = null;
let currentAddress = "";
let currentAccuracy = 0;
let userMarker = null;
let isLocationManuallyAdjusted = false;

// Фильтры
let currentPeriodFilter = 'all';
let currentColorFilter = 'all';
let currentDateFilter = null;

// Статистика
let statsChartInstance = null;
let statsMode = 'histogram';       // 'histogram' или 'timeofday'

// ============ FIREBASE ============
const firebaseConfig = {
    apiKey: "AIzaSyDpLpRywxvtM42c1Ldz4mMwSHzvX3INTg",
    authDomain: "quiet-city.firebaseapp.com",
    projectId: "quiet-city",
    storageBucket: "quiet-city.firebasestorage.app",
    messagingSenderId: "32346551718",
    appId: "1:32346551718:web:23b3d449c3b3bbf96b4b67",
    measurementId: "G-L67ETEDWP"
};

firebase.initializeApp(firebaseConfig);
const dbFirestore = firebase.firestore();

let unsubscribe = null;

// ============ РАБОТА С FIREBASE ============
async function saveMeasurementToCloud(data) {
    try {
        const docRef = await dbFirestore.collection('measurements').add({
            lat: data.lat,
            lng: data.lng,
            address: data.address,
            db: data.db,
            date: data.date,
            time: data.time,
            timestamp: data.timestamp,
            accuracy: data.accuracy || 0,
            source: data.source || 'manual',
            comment: data.comment || ''
        });
        console.log('✅ Замер сохранён в Firebase, ID:', docRef.id);
        return docRef.id;
    } catch (error) {
        console.error('❌ Ошибка сохранения в Firebase:', error);
        throw error;
    }
}

function subscribeToMeasurements() {
    if (unsubscribe) unsubscribe();
    unsubscribe = dbFirestore.collection('measurements')
        .orderBy('timestamp', 'desc')
        .onSnapshot((snapshot) => {
            const cloudMeasurements = [];
            snapshot.forEach((doc) => {
                cloudMeasurements.push({ id: doc.id, ...doc.data() });
            });
            allMeasurements = cloudMeasurements;
            applyFilters();
            renderComments();
            renderHistoryPanel();
            document.getElementById('measureCount').innerText = cloudMeasurements.length;
            console.log('📡 Обновлено из облака, замеров:', cloudMeasurements.length);
        }, (error) => {
            console.error('❌ Ошибка подписки:', error);
        });
}

// ============ КАРТА ============
function initMap() {
    map = L.map('map').setView([55.751574, 37.573856], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false
    });

    map.on('click', async (e) => {
        const { lat, lng } = e.latlng;
        currentLat = lat;
        currentLng = lng;
        currentAccuracy = 0;
        isLocationManuallyAdjusted = true;

        try {
            const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ru`);
            const data = await resp.json();
            currentAddress = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        } catch(e) {
            currentAddress = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }

        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                html: `<div style="background:#2ecc71; width:20px; height:20px; border-radius:50%; border:3px solid white; box-shadow:0 0 10px rgba(46,204,113,0.8);"></div>`,
                iconSize: [20, 20]
            })
        }).addTo(map).bindPopup("📍 Ваша позиция").openPopup();

        document.getElementById('locationInfo').style.display = 'block';
        document.getElementById('locationAddress').innerHTML = `<i class="fas fa-map-pin"></i> ${currentAddress.substring(0, 80)}`;
        document.getElementById('locationAccuracy').innerHTML = `🎯 ручная установка`;
        document.getElementById('saveBtn').disabled = false;
    });
}

// ============ ОТОБРАЖЕНИЕ НА КАРТЕ ============
function getColor(db) {
    if (db < 45) return "#2ecc71";
    if (db < 55) return "#a6e22e";
    if (db < 65) return "#f1c40f";
    if (db < 80) return "#e67e22";
    return "#e74c3c";
}

function getColorCategory(db) {
    if (db < 45) return 'green';
    if (db < 55) return 'lightgreen';
    if (db < 65) return 'yellow';
    if (db < 80) return 'orange';
    return 'red';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function createMarkerWithComment(lat, lng, db, address, id, accuracy, existingComment, source) {
    const color = getColor(db);
    const icon = L.divIcon({
        html: `<div style="background:${color}; width:36px; height:36px; border-radius:50%; border:3px solid white; display:flex; align-items:center; justify-content:center; font-weight:bold; color:white; font-size:13px; box-shadow:0 2px 8px rgba(0,0,0,0.3);">${db}</div>`,
        iconSize: [36, 36],
        className: 'custom-marker'
    });
    const marker = L.marker([lat, lng], { icon });

    let sourceText = '';
    if (source === 'gps') {
        sourceText = `📍 GPS (точность ${Math.round(accuracy)} м)`;
    } else {
        sourceText = '✋ ручная установка';
    }

    let commentsHtml = '';
    if (existingComment && existingComment.trim()) {
        const lines = existingComment.split('\n').filter(s => s.trim());
        commentsHtml = lines.map(line => `<div style="padding:4px 0; border-bottom:1px solid #eee;">${escapeHtml(line)}</div>`).join('');
    } else {
        commentsHtml = '<div style="color:#999; font-style:italic;">Нет комментариев</div>';
    }

    marker.bindPopup(`
        <div style="min-width:200px;">
            <b>${db} дБ</b><br>
            ${address.substring(0, 60)}<br>
            <small>${sourceText}</small>
            <hr style="margin:8px 0;">
            <div style="font-size:12px; margin:8px 0; max-height:120px; overflow-y:auto;" id="popupComments-${id}">
                ${commentsHtml}
            </div>
            <textarea id="comment-input-${id}" rows="2" placeholder="Добавить комментарий..." style="width:100%; margin:4px 0; padding:4px; font-size:11px; border-radius:8px; border:1px solid #ddd;"></textarea>
            <button onclick="addCommentToPoint('${id}')" style="background:#2ecc71; border:none; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:11px; color:white; font-weight:bold;">💬 Добавить комментарий</button>
        </div>
    `);
    return marker;
}

window.addCommentToPoint = async function(id) {
    const commentInput = document.getElementById(`comment-input-${id}`);
    const newComment = commentInput.value.trim();
    if (!newComment) {
        alert("Введите комментарий");
        return;
    }

    try {
        const docRef = dbFirestore.collection('measurements').doc(id);
        const doc = await docRef.get();
        if (!doc.exists) {
            alert("Замер не найден");
            return;
        }
        const data = doc.data();
        const oldComment = data.comment || '';
        const now = new Date();
        const timestamp = now.toLocaleString('ru-RU', { hour12: false });
        const newEntry = `[${timestamp}] ${newComment}`;
        const updatedComment = oldComment ? oldComment + '\n' + newEntry : newEntry;

        await docRef.update({ comment: updatedComment });
        alert("💬 Комментарий добавлен!");
        applyFilters();
    } catch (error) {
        console.error('Ошибка обновления комментария:', error);
        alert("Ошибка добавления комментария");
    }
};

// ============ ФИЛЬТРАЦИЯ ============
function filterByPeriod(measurements, period) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch(period) {
        case 'day':
            return measurements.filter(m => new Date(m.date) >= today);
        case 'week':
            const weekAgo = new Date(today);
            weekAgo.setDate(today.getDate() - 7);
            return measurements.filter(m => new Date(m.date) >= weekAgo);
        case 'month':
            const monthAgo = new Date(today);
            monthAgo.setMonth(today.getMonth() - 1);
            return measurements.filter(m => new Date(m.date) >= monthAgo);
        case 'year':
            const yearAgo = new Date(today);
            yearAgo.setFullYear(today.getFullYear() - 1);
            return measurements.filter(m => new Date(m.date) >= yearAgo);
        default:
            return measurements;
    }
}

function filterByDate(measurements, dateStr) {
    if (!dateStr) return measurements;
    return measurements.filter(m => m.date === dateStr);
}

function filterByColor(measurements, color) {
    if (color === 'all') return measurements;
    return measurements.filter(m => getColorCategory(m.db) === color);
}

function applyFilters() {
    let filtered = allMeasurements;
    filtered = filterByPeriod(filtered, currentPeriodFilter);
    filtered = filterByDate(filtered, currentDateFilter);
    filtered = filterByColor(filtered, currentColorFilter);
    filtered.sort((a, b) => b.db - a.db);

    document.getElementById('totalCount').innerText = allMeasurements.length;
    document.getElementById('filteredCount').innerText = filtered.length;
    document.getElementById('measureCount').innerText = allMeasurements.length;

    if (currentView === 'markers') {
        if (heatLayer) map.removeLayer(heatLayer);
        clusterGroup.clearLayers();
        filtered.forEach(m => {
            clusterGroup.addLayer(createMarkerWithComment(
                m.lat, m.lng, m.db, m.address, m.id, m.accuracy, m.comment, m.source
            ));
        });
        map.addLayer(clusterGroup);
    } else {
        if (clusterGroup) map.removeLayer(clusterGroup);
        if (heatLayer) map.removeLayer(heatLayer);
        const heatData = filtered.map(m => {
            let intensity = (m.db - 30) / 85;
            intensity = Math.min(1, Math.max(0.2, intensity));
            return [m.lat, m.lng, intensity];
        });
        heatLayer = L.heatLayer(heatData, {
            radius: 45,
            blur: 10,
            maxZoom: 18,
            minOpacity: 0.5,
            gradient: {
                0.2: '#2ecc71',
                0.4: '#a6e22e',
                0.6: '#f1c40f',
                0.8: '#e67e22',
                1.0: '#e74c3c'
            }
        });
        map.addLayer(heatLayer);
    }
    renderHistoryPanel(filtered);
}

// ============ ШУМОМЕР ============
async function startMeter() {
    if (isMeterActive) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStream = stream;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        await audioContext.resume();

        const dataArray = new Float32Array(analyser.fftSize);
        function update() {
            if (!analyser) return;
            analyser.getFloatTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            let rms = Math.sqrt(sum / dataArray.length);
            let db = 20 * Math.log10(rms + 0.0001) + 90;
            db = Math.min(115, Math.max(25, db));
            currentDB = Math.floor(db);
            document.getElementById('dbValue').innerText = currentDB;
            const percent = Math.min(100, Math.max(0, ((currentDB - 30) / 85) * 100));
            document.getElementById('meterFill').style.width = percent + '%';
            const dbElement = document.getElementById('dbValue');
            if (currentDB < 50) dbElement.style.color = '#2ecc71';
            else if (currentDB < 70) dbElement.style.color = '#f1c40f';
            else dbElement.style.color = '#e74c3c';
            animationId = requestAnimationFrame(update);
        }
        update();
        isMeterActive = true;
        document.getElementById('startMeterBtn').disabled = true;
        document.getElementById('stopMeterBtn').disabled = false;
        document.getElementById('meterStatus').innerText = 'Активен';
        document.getElementById('meterStatus').style.background = '#2ecc7120';
        document.getElementById('meterStatus').style.color = '#2ecc71';
    } catch(e) {
        alert("Нет доступа к микрофону");
    }
}

function stopMeter() {
    if (animationId) cancelAnimationFrame(animationId);
    if (analyser) try { analyser.disconnect(); } catch(e) {}
    if (audioContext) try { audioContext.close(); } catch(e) {}
    if (mediaStream) mediaStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
    analyser = null;
    audioContext = null;
    mediaStream = null;
    isMeterActive = false;
    document.getElementById('startMeterBtn').disabled = false;
    document.getElementById('stopMeterBtn').disabled = true;
    document.getElementById('meterStatus').innerText = 'Неактивен';
    document.getElementById('meterStatus').style.background = '';
    document.getElementById('meterStatus').style.color = '';
}

// ============ ГЕОЛОКАЦИЯ ============
function getLocation() {
    if (!navigator.geolocation) {
        alert("Геолокация не поддерживается");
        return;
    }
    document.getElementById('locationInfo').style.display = 'block';
    document.getElementById('locationAddress').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Определение...';
    document.getElementById('locationAccuracy').innerHTML = '';
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            currentLat = pos.coords.latitude;
            currentLng = pos.coords.longitude;
            currentAccuracy = pos.coords.accuracy;
            isLocationManuallyAdjusted = false;
            try {
                const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLng}&accept-language=ru`);
                const data = await resp.json();
                currentAddress = data.display_name || `${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
            } catch(e) {
                currentAddress = `${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
            }
            if (userMarker) map.removeLayer(userMarker);
            userMarker = L.marker([currentLat, currentLng], {
                icon: L.divIcon({
                    html: `<div style="background:#2ecc71; width:20px; height:20px; border-radius:50%; border:3px solid white; box-shadow:0 0 10px rgba(46,204,113,0.8);"></div>`,
                    iconSize: [20, 20]
                })
            }).addTo(map).bindPopup("📍 GPS позиция").openPopup();
            document.getElementById('locationAddress').innerHTML = `<i class="fas fa-map-pin"></i> ${currentAddress.substring(0, 80)}`;
            document.getElementById('locationAccuracy').innerHTML = `🎯 точность ${Math.round(currentAccuracy)} м`;
            document.getElementById('saveBtn').disabled = false;
            map.setView([currentLat, currentLng], 16);
        },
        (err) => {
            let errorMsg = "";
            switch(err.code) {
                case 1: errorMsg = "Пользователь запретил доступ"; break;
                case 2: errorMsg = "Не удалось определить положение"; break;
                default: errorMsg = err.message;
            }
            document.getElementById('locationAddress').innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${errorMsg}<br><small>💡 Кликните по карте для ручной установки</small>`;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============ РУЧНОЙ ВВОД ============
function setupManualDb() {
    const input = document.getElementById('manualDbInput');
    const applyBtn = document.getElementById('applyManualDbBtn');
    const status = document.getElementById('manualDbStatus');

    applyBtn.addEventListener('click', () => {
        const val = parseFloat(input.value);
        if (!isNaN(val) && val >= 0 && val <= 150) {
            manualDb = val;
            status.innerText = `✅ Ручное значение: ${manualDb} дБ (будет использовано при сохранении)`;
            status.style.color = '#2ecc71';
        } else {
            manualDb = null;
            status.innerText = '⚠️ Введите корректное число (0-150)';
            status.style.color = '#e74c3c';
        }
    });
}

// ============ МОДАЛЬНОЕ ОКНО КОММЕНТАРИЯ ============
function showCommentModal(dbValue) {
    return new Promise((resolve) => {
        const modal = document.getElementById('commentModal');
        const dbDisplay = document.getElementById('modalDbDisplay');
        const commentInput = document.getElementById('modalCommentInput');
        const skipBtn = document.getElementById('modalSkipBtn');
        const saveBtn = document.getElementById('modalSaveCommentBtn');
        const closeBtn = document.getElementById('modalCloseBtn');
        const cancelBtn = document.getElementById('modalCancelBtn');

        dbDisplay.textContent = dbValue;
        commentInput.value = '';
        modal.style.display = 'flex';
        commentInput.focus();

        const cleanup = () => {
            modal.style.display = 'none';
            document.removeEventListener('keydown', keyHandler);
        };

        const keyHandler = (e) => {
            if (e.key === 'Escape') {
                cleanup();
                resolve(false);
            }
        };
        document.addEventListener('keydown', keyHandler);

        const handleSkip = () => {
            cleanup();
            resolve(null);
        };

        const handleSave = () => {
            const comment = commentInput.value.trim();
            cleanup();
            resolve(comment || null);
        };

        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        skipBtn.onclick = handleSkip;
        saveBtn.onclick = handleSave;
        closeBtn.onclick = handleCancel;
        cancelBtn.onclick = handleCancel;

        modal.onclick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };
    });
}

// ============ СОХРАНЕНИЕ ЗАМЕРА ============
async function saveCurrentMeasurement() {
    let dbValue = null;
    if (manualDb !== null) {
        dbValue = manualDb;
    } else if (isMeterActive) {
        dbValue = currentDB;
    } else {
        alert("❌ Нет данных об уровне шума. Включите шумомер или введите значение вручную.");
        return;
    }

    if (!currentLat) {
        alert("❌ Определите местоположение (GPS или клик по карте)");
        return;
    }

    let source = 'manual';
    if (!isLocationManuallyAdjusted && currentAccuracy > 0) {
        source = 'gps';
    }

    const now = new Date();
    const measurement = {
        lat: currentLat,
        lng: currentLng,
        address: currentAddress,
        db: dbValue,
        date: now.toISOString().slice(0,10),
        time: now.toISOString().slice(11,19),
        timestamp: now.getTime(),
        accuracy: currentAccuracy,
        source: source,
        comment: ""
    };

    const commentResult = await showCommentModal(dbValue);
    if (commentResult === false) {
        return;
    }
    if (commentResult !== null) {
        measurement.comment = commentResult;
    }

    try {
        await saveMeasurementToCloud(measurement);
        const saveBtn = document.getElementById('saveBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Сохранено!';
        saveBtn.style.background = '#2ecc71';
        setTimeout(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.style.background = '';
        }, 2000);
        alert(`✅ ЗАМЕР СОХРАНЁН В ОБЛАКЕ!\n\n📊 ${dbValue} дБ\n📍 ${currentAddress.substring(0, 50)}`);
    } catch(e) {
        alert("❌ Ошибка сохранения: " + e.message);
    }
}

// ============ ПОИСК ============
let searchTimeout;
function setupSearch() {
    const input = document.getElementById('searchInput');
    const results = document.getElementById('searchResults');
    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = input.value;
        if (query.length < 3) {
            results.style.display = 'none';
            return;
        }
        searchTimeout = setTimeout(async () => {
            try {
                const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&accept-language=ru`);
                const data = await resp.json();
                results.innerHTML = '';
                if (data.length) {
                    results.style.display = 'block';
                    data.forEach(place => {
                        const div = document.createElement('div');
                        div.className = 'search-result-item';
                        div.innerHTML = `<i class="fas fa-location-dot"></i> ${place.display_name.substring(0, 70)}`;
                        div.onclick = () => {
                            map.setView([place.lat, place.lon], 16);
                            L.marker([place.lat, place.lon]).addTo(map).bindPopup(place.display_name).openPopup();
                            input.value = place.display_name;
                            results.style.display = 'none';
                        };
                        results.appendChild(div);
                    });
                } else {
                    results.style.display = 'none';
                }
            } catch(e) {
                results.style.display = 'none';
            }
        }, 500);
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) results.style.display = 'none';
    });
}

// ============ КОММЕНТАРИИ ============
function renderComments() {
    const withComments = allMeasurements.filter(m => m.comment && m.comment.trim());
    const container = document.getElementById('commentsList');
    if (withComments.length === 0) {
        container.innerHTML = '<div class="empty-state">💬 Нет комментариев</div>';
        return;
    }
    container.innerHTML = withComments.slice(-10).reverse().map(m => `
        <div class="comment-item" onclick="map.setView([${m.lat}, ${m.lng}], 16)">
            <i class="fas fa-map-marker-alt"></i> <strong>${m.date} ${m.time}</strong> — ${m.db} дБ<br>
            "${escapeHtml(m.comment)}"<br>
            <small>📍 ${m.address.substring(0, 40)}</small>
        </div>
    `).join('');
}

async function addGlobalComment() {
    const comment = document.getElementById('commentInput').value.trim();
    if (!comment) {
        alert("Введите комментарий");
        return;
    }
    if (allMeasurements.length === 0) {
        alert("Нет замеров для комментирования");
        return;
    }
    const last = allMeasurements[0];
    if (last.id) {
        try {
            const docRef = dbFirestore.collection('measurements').doc(last.id);
            const doc = await docRef.get();
            if (!doc.exists) {
                alert("Замер не найден");
                return;
            }
            const data = doc.data();
            const oldComment = data.comment || '';
            const now = new Date();
            const timestamp = now.toLocaleString('ru-RU', { hour12: false });
            const newEntry = `[${timestamp}] ${comment}`;
            const updatedComment = oldComment ? oldComment + '\n' + newEntry : newEntry;
            await docRef.update({ comment: updatedComment });
            document.getElementById('commentInput').value = '';
            alert("💬 Комментарий добавлен к последнему замеру!");
        } catch (e) {
            alert("Ошибка добавления комментария");
        }
    }
}

// ============ ИСТОРИЯ ============
function renderHistoryPanel(filteredMeasurements) {
    const container = document.getElementById('historyPanelList');
    if (!container) return;
    const data = filteredMeasurements || allMeasurements;
    if (data.length === 0) {
        container.innerHTML = '<div class="empty-state">📭 Нет замеров</div>';
        return;
    }
    const recent = data.slice(-15).reverse();
    container.innerHTML = recent.map(m => `
        <div class="history-item" onclick="map.setView([${m.lat}, ${m.lng}], 16)">
            <strong>${m.date} ${m.time}</strong> — <b style="color:${getColor(m.db)}">${m.db} дБ</b><br>
            <small>${m.address.substring(0, 50)}</small>
            ${m.comment ? '<br><small>💬 ' + escapeHtml(m.comment.substring(0, 40)) + '</small>' : ''}
        </div>
    `).join('');
}

function toggleHistoryPanel() {
    const panel = document.getElementById('historyPanel');
    const overlay = document.getElementById('historyOverlay');
    const isActive = panel.classList.toggle('active');
    overlay.classList.toggle('active', isActive);
    if (isActive) renderHistoryPanel();
}

// ============ СТАТИСТИКА ============
function openStatsModal() {
    const modal = document.getElementById('statsModal');
    modal.style.display = 'flex';
    // Демо-данные, если замеров нет
    if (allMeasurements.length === 0) {
        const now = Date.now();
        const demo = [
            { db: 42, timestamp: now - 86400000 * 2 },
            { db: 57, timestamp: now - 86400000 * 1 },
            { db: 73, timestamp: now },
            { db: 48, timestamp: now - 86400000 * 3 },
            { db: 61, timestamp: now - 86400000 * 0.5 }
        ];
        buildStatsWithData(demo);
    } else {
        buildStats();
    }
    // Принудительно пересчитываем размер карты, чтобы модалка не влияла на отображение
    setTimeout(() => map.invalidateSize(), 100);
}

function closeStatsModal() {
    document.getElementById('statsModal').style.display = 'none';
}

function buildStats() {
    buildStatsWithData(allMeasurements);
}

function buildStatsWithData(data) {
    const total = data.length;
    document.getElementById('statsTotal').textContent = total;
    if (total === 0) {
        document.getElementById('statsAvg').textContent = '—';
        document.getElementById('statsMin').textContent = '—';
        document.getElementById('statsMax').textContent = '—';
        const ctx = document.getElementById('statsChart').getContext('2d');
        if (statsChartInstance) statsChartInstance.destroy();
        statsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: ['Нет данных'], datasets: [{ data: [0], backgroundColor: '#ccc' }] },
            options: { responsive: true, plugins: { legend: { display: false } } }
        });
        document.getElementById('statsDemoHint').style.display = 'block';
        return;
    }
    document.getElementById('statsDemoHint').style.display = 'none';
    const dbs = data.map(m => m.db);
    const avg = (dbs.reduce((a,b) => a + b, 0) / total).toFixed(1);
    const min = Math.min(...dbs);
    const max = Math.max(...dbs);
    document.getElementById('statsAvg').textContent = avg;
    document.getElementById('statsMin').textContent = min;
    document.getElementById('statsMax').textContent = max;

    if (statsMode === 'histogram') {
        renderHistogram(data);
    } else {
        renderTimeOfDay(data);
    }
}

// ----- 1. Гистограмма (распределение) -----
function renderHistogram(data) {
    const ctx = document.getElementById('statsChart').getContext('2d');
    if (statsChartInstance) statsChartInstance.destroy();
    const ranges = [
        { label: '<45', min: 0, max: 45 },
        { label: '45-55', min: 45, max: 55 },
        { label: '55-65', min: 55, max: 65 },
        { label: '65-80', min: 65, max: 80 },
        { label: '>80', min: 80, max: 150 }
    ];
    const counts = ranges.map(r => data.filter(m => m.db >= r.min && m.db < r.max).length);
    statsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ranges.map(r => r.label),
            datasets: [{
                label: 'Количество замеров',
                data: counts,
                backgroundColor: ['#2ecc71', '#a6e22e', '#f1c40f', '#e67e22', '#e74c3c'],
                borderColor: ['#1f8b4c', '#7fa31e', '#c9a10e', '#b85d1a', '#b03a2e'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                title: { display: true, text: 'Распределение по уровню шума' }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Количество замеров' }
                }
            }
        }
    });
}

// ----- 2. Время суток -----
function renderTimeOfDay(data) {
    const ctx = document.getElementById('statsChart').getContext('2d');
    if (statsChartInstance) statsChartInstance.destroy();

    const timeGroups = {
        'Ночь (0-6)': [],
        'Утро (6-12)': [],
        'День (12-18)': [],
        'Вечер (18-24)': []
    };

    data.forEach(m => {
        const d = new Date(m.timestamp);
        const hour = d.getHours();
        if (hour >= 0 && hour < 6) timeGroups['Ночь (0-6)'].push(m.db);
        else if (hour >= 6 && hour < 12) timeGroups['Утро (6-12)'].push(m.db);
        else if (hour >= 12 && hour < 18) timeGroups['День (12-18)'].push(m.db);
        else if (hour >= 18 && hour < 24) timeGroups['Вечер (18-24)'].push(m.db);
    });

    const labels = Object.keys(timeGroups);
    const avgValues = labels.map(label => {
        const vals = timeGroups[label];
        if (vals.length === 0) return 0;
        return vals.reduce((a,b) => a + b, 0) / vals.length;
    });
    const counts = labels.map(label => timeGroups[label].length);

    statsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Средний уровень (дБ)',
                    data: avgValues,
                    backgroundColor: ['#2ecc71', '#f1c40f', '#e67e22', '#3498db'],
                    borderColor: ['#1f8b4c', '#c9a10e', '#b85d1a', '#2980b9'],
                    borderWidth: 1,
                    order: 1
                },
                {
                    label: 'Количество замеров',
                    data: counts,
                    backgroundColor: 'rgba(200,200,200,0.3)',
                    borderColor: '#aaa',
                    borderWidth: 1,
                    type: 'line',
                    order: 0,
                    pointRadius: 3,
                    borderDash: [5,5],
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom' },
                title: { display: true, text: 'Средний уровень шума по времени суток' }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'дБ' }
                },
                y1: {
                    position: 'right',
                    beginAtZero: true,
                    title: { display: true, text: 'Количество' },
                    grid: { drawOnChartArea: false }
                }
            }
        }
    });
}

// ============ ПЕРЕКЛЮЧЕНИЕ ВИДОВ ============
function setupViewSwitcher() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentView = btn.dataset.view;
            applyFilters();
        });
    });
}

// ============ ФИЛЬТРЫ ============
function setupFilters() {
    document.querySelectorAll('.filter-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPeriodFilter = btn.dataset.period;
            currentDateFilter = null;
            flatpickrInstance && flatpickrInstance.clear();
            applyFilters();
        });
    });
    document.querySelectorAll('.filter-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentColorFilter = btn.dataset.color;
            applyFilters();
        });
    });
    document.getElementById('periodMenuBtn').addEventListener('click', () => {
        const menu = document.getElementById('periodMenu');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
}

// ============ КАЛЕНДАРЬ ============
let flatpickrInstance;

function setupCalendar() {
    flatpickrInstance = flatpickr("#datePicker", {
        locale: "ru",
        dateFormat: "Y-m-d",
        placeholder: "Выберите дату",
        onChange: function(selectedDates, dateStr) {
            if (dateStr) {
                currentDateFilter = dateStr;
                document.querySelectorAll('.filter-period-btn').forEach(b => b.classList.remove('active'));
                currentPeriodFilter = 'all';
                applyFilters();
            } else {
                currentDateFilter = null;
                applyFilters();
            }
        }
    });
}

// ============ НАСТРОЙКА СТАТИСТИКИ ============
function setupStatsControls() {
    document.querySelectorAll('.stats-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stats-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            statsMode = btn.dataset.mode;
            buildStats();
        });
    });
}

// ============ PWA ============
function setupPWA() {
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const pwaBtn = document.createElement('button');
        pwaBtn.innerHTML = '<i class="fas fa-download"></i> 📱 Сохранить на телефон';
        pwaBtn.className = 'btn btn-primary';
        pwaBtn.style.position = 'fixed';
        pwaBtn.style.bottom = '20px';
        pwaBtn.style.right = '20px';
        pwaBtn.style.zIndex = '1000';
        pwaBtn.style.borderRadius = '50px';
        pwaBtn.style.padding = '12px 20px';
        pwaBtn.onclick = () => {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(() => pwaBtn.remove());
        };
        document.body.appendChild(pwaBtn);
    });
}

// ============ ОНЛАЙН/ОФЛАЙН ============
function setupNetworkHandlers() {
    const banner = document.getElementById('offlineBanner');
    if (!banner) return;
    function updateBanner() {
        if (!navigator.onLine) {
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    }
    window.addEventListener('online', updateBanner);
    window.addEventListener('offline', updateBanner);
    updateBanner();
}

// ============ ЗАПУСК ============
async function init() {
    initMap();
    subscribeToMeasurements();
    setupSearch();
    setupViewSwitcher();
    setupFilters();
    setupCalendar();
    setupPWA();
    setupNetworkHandlers();
    setupManualDb();
    setupStatsControls();

    document.getElementById('historyToggleBtn').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyPanelClose').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyOverlay').addEventListener('click', toggleHistoryPanel);
    document.getElementById('startMeterBtn').onclick = startMeter;
    document.getElementById('stopMeterBtn').onclick = stopMeter;
    document.getElementById('getLocationBtn').onclick = getLocation;
    document.getElementById('saveBtn').onclick = saveCurrentMeasurement;
    document.getElementById('addCommentBtn').onclick = addGlobalComment;

    document.getElementById('statsBtn').addEventListener('click', openStatsModal);
    document.getElementById('statsModalClose').addEventListener('click', closeStatsModal);
    document.getElementById('statsModalCloseBtn').addEventListener('click', closeStatsModal);
    document.getElementById('statsModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeStatsModal();
    });

    setTimeout(() => map.invalidateSize(), 500);
    console.log("✅ Приложение готово! Данные синхронизируются через Firebase в реальном времени.");
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('✅ Service Worker зарегистрирован', reg))
            .catch(err => console.error('❌ Ошибка регистрации SW', err));
    }
}

document.addEventListener('DOMContentLoaded', init);
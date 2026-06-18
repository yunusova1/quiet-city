// ============ ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ============
let map;
let clusterGroup;
let heatLayer;
let currentView = 'cluster';
let allMeasurements = [];

// Шумомер
let mediaStream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let currentDB = 0;
let isMeterActive = false;

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

// ============ НАСТРОЙКА FIREBASE ============
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

// ============ ИНИЦИАЛИЗАЦИЯ КАРТЫ ============
function initMap() {
    map = L.map('map').setView([55.751574, 37.573856], 12);

    // ⭐ ЦВЕТНАЯ КАРТА (стандартные OSM тайлы)
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
        isLocationManuallyAdjusted = false;

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

function createMarkerWithComment(lat, lng, db, address, id, accuracy, existingComment) {
    const color = getColor(db);
    const icon = L.divIcon({
        html: `<div style="background:${color}; width:36px; height:36px; border-radius:50%; border:3px solid white; display:flex; align-items:center; justify-content:center; font-weight:bold; color:white; font-size:13px; box-shadow:0 2px 8px rgba(0,0,0,0.3);">${db}</div>`,
        iconSize: [36, 36],
        className: 'custom-marker'
    });
    const marker = L.marker([lat, lng], { icon });

    const commentHtml = (existingComment && existingComment.trim())
        ? `<i class="fas fa-comment"></i> "${escapeHtml(existingComment)}"`
        : '<i class="fas fa-comment-dots"></i> Нет комментариев';

    marker.bindPopup(`
        <div style="min-width:200px;">
            <b>${db} дБ</b><br>
            ${address.substring(0, 60)}<br>
            <small>🎯 ${accuracy ? Math.round(accuracy) + ' м' : 'ручная'}</small>
            <hr style="margin:8px 0;">
            <div style="font-size:12px; margin:8px 0;" id="popupComment-${id}">
                ${commentHtml}
            </div>
            <textarea id="comment-input-${id}" rows="2" placeholder="Добавить комментарий..." style="width:100%; margin:4px 0; padding:4px; font-size:11px; border-radius:8px; border:1px solid #ddd;"></textarea>
            <button onclick="addCommentToPoint('${id}')" style="background:#2ecc71; border:none; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:11px; color:white; font-weight:bold;">💬 Добавить комментарий</button>
        </div>
    `);
    return marker;
}

window.addCommentToPoint = async function(id) {
    const commentInput = document.getElementById(`comment-input-${id}`);
    const comment = commentInput.value.trim();
    if (!comment) {
        alert("Введите комментарий");
        return;
    }
    try {
        await dbFirestore.collection('measurements').doc(id).update({ comment: comment });
        alert("💬 Комментарий добавлен!");
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

    if (currentView === 'cluster') {
        if (heatLayer) map.removeLayer(heatLayer);
        clusterGroup.clearLayers();
        filtered.forEach(m => {
            clusterGroup.addLayer(createMarkerWithComment(m.lat, m.lng, m.db, m.address, m.id, m.accuracy, m.comment));
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
            radius: 35, blur: 20, maxZoom: 18, minOpacity: 0.5,
            gradient: {
                0.2: '#2ecc71', 0.4: '#a6e22e', 0.6: '#f1c40f', 0.8: '#e67e22', 1.0: '#e74c3c'
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
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        await audioContext.resume();

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        function update() {
            if (!analyser) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            let avg = sum / dataArray.length;
            let db = Math.min(115, Math.max(30, 20 * Math.log10(avg + 1) + 35));
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

function adjustLocation() {
    if (!currentLat || !currentLng) {
        alert("Сначала определите местоположение");
        return;
    }
    const radius = 50;
    const radiusDeg = radius / 111000;
    const latOffset = (Math.random() - 0.5) * 2 * radiusDeg;
    const lngOffset = (Math.random() - 0.5) * 2 * radiusDeg / Math.cos(currentLat * Math.PI / 180);
    currentLat += latOffset;
    currentLng += lngOffset;
    isLocationManuallyAdjusted = true;
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([currentLat, currentLng], {
        icon: L.divIcon({
            html: `<div style="background:#f39c12; width:20px; height:20px; border-radius:50%; border:3px solid white; box-shadow:0 0 10px rgba(243,156,18,0.8);"></div>`,
            iconSize: [20, 20]
        })
    }).addTo(map).bindPopup("📍 Уточненная позиция (±50 м)").openPopup();
    document.getElementById('locationAccuracy').innerHTML = `✏️ скорректировано ±50 м`;
    map.setView([currentLat, currentLng], 16);
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLng}&accept-language=ru`)
        .then(res => res.json())
        .then(data => {
            currentAddress = data.display_name || `${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
            document.getElementById('locationAddress').innerHTML = `<i class="fas fa-map-pin"></i> ${currentAddress.substring(0, 80)}`;
        })
        .catch(() => {});
}

function showCommentModal(dbValue) {
    return new Promise((resolve) => {
        const modal = document.getElementById('commentModal');
        const dbDisplay = document.getElementById('modalDbDisplay');
        const commentInput = document.getElementById('modalCommentInput');
        const skipBtn = document.getElementById('modalSkipBtn');
        const saveBtn = document.getElementById('modalSaveCommentBtn');
        const closeBtn = document.getElementById('modalCloseBtn');
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
                resolve(null);
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
        skipBtn.onclick = handleSkip;
        saveBtn.onclick = handleSave;
        closeBtn.onclick = handleSkip;
        modal.onclick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(null);
            }
        };
    });
}

async function saveCurrentMeasurement() {
    if (!isMeterActive) {
        alert("❌ Сначала включите шумомер!");
        return;
    }
    if (!currentLat) {
        alert("❌ Определите местоположение (GPS или клик по карте)");
        return;
    }
    if (currentDB === 0) {
        alert("❌ Нет данных с шумомера");
        return;
    }
    if (currentAccuracy === 0 && !isLocationManuallyAdjusted) {
        alert("❌ Местоположение не достоверно!\n\nИспользуйте GPS или уточните позицию (радиус 50 м)");
        return;
    }
    const now = new Date();
    const measurement = {
        lat: currentLat,
        lng: currentLng,
        address: currentAddress,
        db: currentDB,
        date: now.toISOString().slice(0,10),
        time: now.toISOString().slice(11,19),
        timestamp: now.getTime(),
        accuracy: currentAccuracy,
        comment: ""
    };
    const comment = await showCommentModal(currentDB);
    if (comment !== null) measurement.comment = comment;
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
        alert(`✅ ЗАМЕР СОХРАНЁН В ОБЛАКЕ!\n\n📊 ${currentDB} дБ\n📍 ${currentAddress.substring(0, 50)}`);
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
            await dbFirestore.collection('measurements').doc(last.id).update({ comment: comment });
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

// ============ НАСТРОЙКА ФИЛЬТРОВ ============
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

// ============ ЗАПУСК ============
async function init() {
    initMap();
    subscribeToMeasurements();
    setupSearch();
    setupViewSwitcher();
    setupFilters();
    setupCalendar();
    setupPWA();
    document.getElementById('historyToggleBtn').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyPanelClose').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyOverlay').addEventListener('click', toggleHistoryPanel);
    document.getElementById('startMeterBtn').onclick = startMeter;
    document.getElementById('stopMeterBtn').onclick = stopMeter;
    document.getElementById('getLocationBtn').onclick = getLocation;
    document.getElementById('adjustLocationBtn').onclick = adjustLocation;
    document.getElementById('saveBtn').onclick = saveCurrentMeasurement;
    document.getElementById('addCommentBtn').onclick = addGlobalComment;
    setTimeout(() => map.invalidateSize(), 500);
    console.log("✅ Приложение готово! Данные синхронизируются через Firebase в реальном времени.");
}

document.addEventListener('DOMContentLoaded', init);
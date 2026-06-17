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
let currentDateFilter = null; // для календаря

// База данных
let db;
const DB_NAME = "QuietCityDB";
const STORE_NAME = "measurements";

// Переменная для модального окна
let pendingMeasurement = null;

// ============ ИНИЦИАЛИЗАЦИЯ КАРТЫ ============
function initMap() {
    map = L.map('map').setView([55.751574, 37.573856], 12);
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);
    
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false
    });
    
    // Клик по карте для ручной установки позиции
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

// ============ РАБОТА С БАЗОЙ ДАННЫХ ============
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2);
        request.onerror = () => reject("DB error");
        request.onsuccess = () => {
            db = request.result;
            resolve();
        };
        request.onupgradeneeded = (e) => {
            if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                const store = e.target.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
                store.createIndex("date", "date", { unique: false });
                store.createIndex("timestamp", "timestamp", { unique: false });
            }
        };
    });
}

async function saveMeasurement(data) {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.add(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllMeasurements() {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
    });
}

async function updateMeasurement(meas) {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.put(meas);
        request.onsuccess = () => resolve();
        request.onerror = () => reject();
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

// Создание маркера с поддержкой комментариев
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
            <button onclick="addCommentToPoint(${id})" style="background:#2ecc71; border:none; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:11px; color:white; font-weight:bold;">💬 Добавить комментарий</button>
        </div>
    `);
    return marker;
}

// Добавление комментария к точке
window.addCommentToPoint = async function(id) {
    const commentInput = document.getElementById(`comment-input-${id}`);
    const comment = commentInput.value.trim();
    if (!comment) {
        alert("Введите комментарий");
        return;
    }
    
    const measurements = await getAllMeasurements();
    const measurement = measurements.find(m => m.id === id);
    if (measurement) {
        measurement.comment = comment;
        await updateMeasurement(measurement);
        
        const popupComment = document.getElementById(`popupComment-${id}`);
        if (popupComment) {
            popupComment.innerHTML = `<i class="fas fa-comment"></i> "${escapeHtml(comment)}"`;
        }
        
        await applyFilters();
        renderComments();
        renderHistoryPanel();
        alert("💬 Комментарий добавлен к точке!");
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

async function applyFilters() {
    let filtered = await getAllMeasurements();
    filtered = filterByPeriod(filtered, currentPeriodFilter);
    filtered = filterByDate(filtered, currentDateFilter);
    filtered = filterByColor(filtered, currentColorFilter);
    
    // Сортируем по убыванию уровня шума
    filtered.sort((a, b) => b.db - a.db);
    
    document.getElementById('totalCount').innerText = (await getAllMeasurements()).length;
    document.getElementById('filteredCount').innerText = filtered.length;
    document.getElementById('measureCount').innerText = filtered.length;
    
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
                case 1: errorMsg = "Пользователь запретил доступ";
                break;
                case 2: errorMsg = "Не удалось определить положение";
                break;
                default: errorMsg = err.message;
            }
            document.getElementById('locationAddress').innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${errorMsg}<br><small>💡 Кликните по карте для ручной установки</small>`;
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============ УТОЧНЕНИЕ ПОЗИЦИИ (РАДИУС 50 М) ============
function adjustLocation() {
    if (!currentLat || !currentLng) {
        alert("Сначала определите местоположение");
        return;
    }
    
    const radius = 50; // метров
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
    
    // Обновляем адрес
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLng}&accept-language=ru`)
        .then(res => res.json())
        .then(data => {
            currentAddress = data.display_name || `${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
            document.getElementById('locationAddress').innerHTML = `<i class="fas fa-map-pin"></i> ${currentAddress.substring(0, 80)}`;
        })
        .catch(() => {});
}

// ============ МОДАЛЬНОЕ ОКНО ДЛЯ КОММЕНТАРИЯ ============
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
        
        // Закрытие по клику на фон
        modal.onclick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(null);
            }
        };
    });
}

// ============ СОХРАНЕНИЕ ЗАМЕРА ============
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
    
    // Проверка достоверности местоположения (ручной ввод без GPS)
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
    
    // Показываем модальное окно для комментария
    const comment = await showCommentModal(currentDB);
    if (comment !== null) {
        measurement.comment = comment;
    }
    
    try {
        await saveMeasurement(measurement);
        await applyFilters();
        renderComments();
        renderHistoryPanel();
        
        const saveBtn = document.getElementById('saveBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Сохранено!';
        saveBtn.style.background = '#2ecc71';
        setTimeout(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.style.background = '';
        }, 2000);
        
        alert(`✅ ЗАМЕР СОХРАНЁН!\n\n📊 ${currentDB} дБ\n📍 ${currentAddress.substring(0, 50)}\n${comment ? '💬 "' + comment + '"' : ''}`);
    } catch(e) {
        alert("❌ Ошибка сохранения");
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
async function renderComments() {
    const measurements = await getAllMeasurements();
    const withComments = measurements.filter(m => m.comment && m.comment.trim());
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
    
    const measurements = await getAllMeasurements();
    if (measurements.length === 0) {
        alert("Нет замеров для комментирования");
        return;
    }
    
    const last = measurements[measurements.length - 1];
    last.comment = comment;
    await updateMeasurement(last);
    document.getElementById('commentInput').value = '';
    renderComments();
    renderHistoryPanel();
    applyFilters();
    alert("💬 Комментарий добавлен к последнему замеру!");
}

// ============ ИСТОРИЯ (ПАНЕЛЬ) ============
function renderHistoryPanel(filteredMeasurements) {
    const container = document.getElementById('historyPanelList');
    if (!container) return;
    
    // Если не переданы отфильтрованные, берем все
    if (!filteredMeasurements) {
        getAllMeasurements().then(measurements => {
            renderHistoryPanel(measurements);
        });
        return;
    }
    
    if (filteredMeasurements.length === 0) {
        container.innerHTML = '<div class="empty-state">📭 Нет замеров</div>';
        return;
    }
    
    // Берем последние 15
    const recent = filteredMeasurements.slice(-15).reverse();
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
    if (isActive) {
        renderHistoryPanel();
    }
}

// ============ ЭКСПОРТ/ИМПОРТ ============
async function exportToFile() {
    const measurements = await getAllMeasurements();
    const data = {
        exportDate: new Date().toISOString(),
        version: "1.0",
        totalMeasurements: measurements.length,
        measurements: measurements
    };
    
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quiet_city_backup_${new Date().toISOString().slice(0,19)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert(`📁 Данные экспортированы!\nВсего замеров: ${measurements.length}`);
}

async function importFromFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.measurements && Array.isArray(data.measurements)) {
                let importedCount = 0;
                for (const measurement of data.measurements) {
                    delete measurement.id;
                    await saveMeasurement(measurement);
                    importedCount++;
                }
                await applyFilters();
                renderComments();
                renderHistoryPanel();
                alert(`✅ Импортировано ${importedCount} замеров!`);
            } else {
                alert("Неверный формат файла");
            }
        } catch(e) {
            alert("Ошибка при импорте файла");
        }
    };
    reader.readAsText(file);
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
    // Фильтры по периоду
    document.querySelectorAll('.filter-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPeriodFilter = btn.dataset.period;
            currentDateFilter = null; // сбрасываем календарь
            flatpickrInstance && flatpickrInstance.clear();
            applyFilters();
        });
    });
    
    // Фильтры по цвету
    document.querySelectorAll('.filter-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentColorFilter = btn.dataset.color;
            applyFilters();
        });
    });
    
    // Кнопка меню периода
    document.getElementById('periodMenuBtn').addEventListener('click', () => {
        const menu = document.getElementById('periodMenu');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
}

// ============ НАСТРОЙКА КАЛЕНДАРЯ ============
let flatpickrInstance;

function setupCalendar() {
    flatpickrInstance = flatpickr("#datePicker", {
        locale: "ru",
        dateFormat: "Y-m-d",
        placeholder: "Выберите дату",
        onChange: function(selectedDates, dateStr, instance) {
            if (dateStr) {
                currentDateFilter = dateStr;
                // Снимаем активность с кнопок периода
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

// ============ PWA УСТАНОВКА ============
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
    await initDB();
    await applyFilters();
    setupSearch();
    setupViewSwitcher();
    setupFilters();
    setupCalendar();
    setupPWA();
    renderComments();
    renderHistoryPanel();
    
    // История
    document.getElementById('historyToggleBtn').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyPanelClose').addEventListener('click', toggleHistoryPanel);
    document.getElementById('historyOverlay').addEventListener('click', toggleHistoryPanel);
    
    // Шумомер
    document.getElementById('startMeterBtn').onclick = startMeter;
    document.getElementById('stopMeterBtn').onclick = stopMeter;
    
    // Геолокация
    document.getElementById('getLocationBtn').onclick = getLocation;
    document.getElementById('adjustLocationBtn').onclick = adjustLocation;
    document.getElementById('saveBtn').onclick = saveCurrentMeasurement;
    
    // Комментарии
    document.getElementById('addCommentBtn').onclick = addGlobalComment;
    
    // Экспорт/Импорт
    document.getElementById('exportBtn').onclick = exportToFile;
    document.getElementById('importFile').onchange = (e) => {
        if (e.target.files[0]) importFromFile(e.target.files[0]);
    };
    
    console.log("✅ Приложение готово!");
    console.log("📌 Функции: комментарии к точкам, фильтры по периоду/цвету, экспорт/импорт JSON");
}

// Запуск при загрузке
document.addEventListener('DOMContentLoaded', init);
// sw.js – Service Worker для офлайн-режима

const CACHE_NAME = 'quiet-city-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json'
];

// Установка – кешируем статику
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Кешируем статику');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Активация – удаляем старые кеши
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
  return self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        // Кешируем новые ресурсы из сети (кроме карт OSM)
        return fetch(event.request).then(fetchResponse => {
          if (fetchResponse && fetchResponse.status === 200 &&
              !event.request.url.includes('tile.openstreetmap.org')) {
            const clone = fetchResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, clone);
            });
          }
          return fetchResponse;
        });
      })
      .catch(() => {
        // Если нет сети и кеша
        return new Response('Нет соединения с интернетом', { status: 503 });
      })
  );
});
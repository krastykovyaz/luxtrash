// Minimal service worker — its only job is receiving Web Push messages and
// showing them as OS notifications. No offline caching, no asset
// interception: registering it is just the browser's required plumbing for
// push to work at all.

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || "Bin Duty";
  var options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" }
  };
  // A tag makes a new notification replace the previous one with that tag
  // (several chat messages become one entry, not a stack) and still alert.
  if (data.tag) { options.tag = data.tag; options.renotify = true; }
  event.waitUntil(self.registration.showNotification(title, options));
});

// An installed iPhone web app launches at its start page and ignores the
// address a tapped notification carries (openWindow/navigate never get to
// load it), so the destination is left in Cache Storage for the page to pick
// up itself — on launch, when it's brought forward, or when pinged below.
var INTENT_CACHE = "bd-open-intent";
var INTENT_KEY = "/__open-intent";

function saveIntent(url) {
  return caches.open(INTENT_CACHE).then(function (c) {
    return c.put(INTENT_KEY, new Response(JSON.stringify({ url: url, at: Date.now() }), { headers: { "content-type": "application/json" } }));
  }).catch(function () {});
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    saveIntent(url)
      .then(function () { return self.clients.matchAll({ type: "window", includeUncontrolled: true }); })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          if ("focus" in list[i]) {
            list[i].postMessage({ type: "open-intent" });
            return list[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
      .catch(function () {})
  );
});

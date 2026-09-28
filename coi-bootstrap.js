/*
 * Small page bootstrap for coi-serviceworker. The package-owned script is
 * registered as a Service Worker below; it is never executed as page code.
 * Keep this classic script root-scoped so it works at both / and /repo/.
 */
(() => {
  const current = document.currentScript;
  const serviceWorkerUrl = current && current.src
    ? new URL("coi-serviceworker.js", current.src).href
    : new URL("./coi-serviceworker.js", document.baseURI).href;
  const reloadKey = `__coi_service_worker_reload__:${location.pathname}`;
  let reloadRequested = false;

  const reloadOnce = () => {
    if (reloadRequested) return;
    reloadRequested = true;
    try {
      if (sessionStorage.getItem(reloadKey)) return;
      sessionStorage.setItem(reloadKey, "1");
    } catch {
      // A blocked sessionStorage must not make the page unusable.
    }
    location.reload();
  };

  let serviceWorker;
  try {
    serviceWorker = navigator.serviceWorker;
  } catch {
    return;
  }
  if (!serviceWorker || window.crossOriginIsolated) return;

  const onControllerChange = () => reloadOnce();
  serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });

  try {
    const registrationResult = serviceWorker.register(serviceWorkerUrl);
    Promise.resolve(registrationResult).then((registration) => {
      if (!registration) return;
      const observeActivation = (worker) => {
        if (!worker) return;
        if (worker.state === "activated" && !serviceWorker.controller) reloadOnce();
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated" && !serviceWorker.controller) reloadOnce();
        }, { once: true });
      };
      if (registration.active && !serviceWorker.controller) reloadOnce();
      observeActivation(registration.installing);
      observeActivation(registration.waiting);
    }, () => {
      // Service Worker/SAB isolation is an optional enhancement; the client
      // has a Worker-local legacy fallback when registration is unavailable.
    });
  } catch {
    // Unsupported or blocked registration is intentionally non-fatal.
  }
})();

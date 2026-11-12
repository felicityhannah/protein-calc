// Optional usage measurement. No events are queued before the SDK loads or consent.
const EVENTS = new Set(['calculation_complete', 'tracker_open', 'food_logged', 'guide_view']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);

export function createAnalytics({ measurementId, getConsent, getLanguage,
  onStatusChange = () => {}, browserWindow = globalThis.window,
  browserDocument = globalThis.document, timeoutMs = 15000 } = {}) {
  const id = typeof measurementId === 'string' ? measurementId : '';
  let status = 'off';
  let sdkLoaded = false;
  let configured = false;
  let initialPageViewSent = false;
  let pending = null;
  let disposed = false;

  const allowed = () => getConsent?.() === true;
  const pageLocation = () => `${browserWindow.location.origin}${browserWindow.location.pathname}`;
  const eligible = () => /^G-[A-Z0-9]+$/.test(id) &&
    !LOCAL_HOSTS.has(browserWindow.location.hostname.toLowerCase());

  function setStatus(next) {
    status = next;
    onStatusChange(next);
  }

  function setDisabled(value) {
    if (/^G-[A-Z0-9]+$/.test(id)) browserWindow[`ga-disable-${id}`] = value;
  }

  function connect() {
    if (disposed || !sdkLoaded || !eligible() || !allowed()) return false;
    setDisabled(false);
    if (!configured) {
      configured = true;
      browserWindow.gtag('js', new Date());
      // Explicit page_view below keeps consent changes/retries from duplicating it.
      browserWindow.gtag('config', id, {
        send_page_view: false,
        page_location: pageLocation(),
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      });
    }
    if (!initialPageViewSent) {
      initialPageViewSent = true;
      browserWindow.gtag('event', 'page_view', {
        page_location: pageLocation(), language: getLanguage?.() || 'en',
      });
    }
    setStatus('loaded');
    return true;
  }

  function startLoading() {
    browserWindow.dataLayer = browserWindow.dataLayer || [];
    if (typeof browserWindow.gtag !== 'function') {
      browserWindow.gtag = function () { browserWindow.dataLayer.push(arguments); };
    }
    const script = browserDocument.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const attempt = { script, promise, resolve, timer: null };
    pending = attempt;
    const finish = success => {
      // Ignore an old callback after an error, timeout or disposal.
      if (pending !== attempt) return;
      pending = null;
      clearTimeout(attempt.timer);
      script.onload = null;
      script.onerror = null;
      if (!success) {
        script.remove();
        sdkLoaded = false;
        setDisabled(true);
        setStatus(allowed() ? 'error' : 'off');
        resolve(false);
        return;
      }
      sdkLoaded = true;
      if (!allowed()) {
        setDisabled(true);
        setStatus('off');
        resolve(false);
      } else resolve(connect());
    };
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    attempt.timer = setTimeout(() => finish(false), timeoutMs);
    setStatus('loading');
    try { browserDocument.head.append(script); }
    catch { finish(false); }
    return promise;
  }

  return {
    get status() { return status; },
    syncConsent() {
      if (disposed) return Promise.resolve(false);
      if (!/^G-[A-Z0-9]+$/.test(id)) { setStatus('unconfigured'); return Promise.resolve(false); }
      if (!eligible()) { setDisabled(true); setStatus('local'); return Promise.resolve(false); }
      if (!allowed()) { setDisabled(true); setStatus('off'); return Promise.resolve(false); }
      setDisabled(false);
      if (sdkLoaded) return Promise.resolve(connect());
      if (pending) { setStatus('loading'); return pending.promise; }
      return startLoading();
    },
    track(event) {
      if (disposed || !sdkLoaded || !configured || !eligible() || !allowed() || !EVENTS.has(event)) return false;
      browserWindow.gtag('event', event, {
        language: getLanguage?.() || 'en', page_location: pageLocation(),
      });
      return true;
    },
    dispose() {
      disposed = true;
      setDisabled(true);
      if (pending) {
        const attempt = pending;
        pending = null;
        clearTimeout(attempt.timer);
        attempt.script.onload = null;
        attempt.script.onerror = null;
        attempt.script.remove();
        attempt.resolve(false);
      }
      setStatus('off');
    },
  };
}

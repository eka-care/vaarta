// Vaarta Scribe embed SDK. API: docs/partner-embed-integration.md
(function () {
  'use strict';

  var PARTNER_SOURCE = 'eka-scribe-embed';
  var SCRIBE_SOURCE = 'eka-scribe';
  // Fast until connected (the doctor may be signing in), then a slow self-healing keepalive.
  var HELLO_FAST_MS = 300;
  var HELLO_KEEPALIVE_MS = 3000;
  var CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

  var SCRIPT_ORIGIN = (function () {
    try {
      return new URL(document.currentScript.src).origin;
    } catch (e) {
      return window.location.origin;
    }
  })();

  function randomId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function createClient(options) {
    var config = options || {};
    var scribeOrigin = config.scribeOrigin || SCRIPT_ORIGIN;
    var embedPath = config.embedPath || '/embed';
    var windowName = config.windowName || 'eka-scribe';
    var windowFeatures = config.windowFeatures || 'width=1280,height=860';

    var popup = null;
    var listening = false;
    var timer = null;

    var handoffId = null;
    var requestId = null;
    var payload = null;
    var callbacks = {};
    var connected = false;
    var requestSent = false;
    var acked = false;
    var deadline = 0;

    function emit(name, arg) {
      var fn = callbacks[name];
      if (typeof fn !== 'function') return;
      try {
        fn(arg);
      } catch (error) {
        console.error('[eka-scribe] ' + name + ' threw:', error);
      }
    }

    function fail(code, message) {
      emit('onError', { code: code, message: message });
    }

    function stopPump() {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function pump() {
      timer = null;

      if (!popup || popup.closed) {
        stopPump();
        popup = null;
        connected = false;
        emit('onClose');
        return;
      }

      if (!connected && Date.now() > deadline) {
        stopPump();
        fail('connect_timeout', 'Scribe did not respond. The doctor may not have signed in.');
        return;
      }

      popup.postMessage(
        { source: PARTNER_SOURCE, type: 'hello', handoff_id: handoffId },
        scribeOrigin
      );
      timer = setTimeout(pump, connected ? HELLO_KEEPALIVE_MS : HELLO_FAST_MS);
    }

    function sendRequest() {
      if (requestSent || !popup || popup.closed) return;
      requestSent = true;
      popup.postMessage(
        {
          source: PARTNER_SOURCE,
          type: 'create-session',
          handoff_id: handoffId,
          request_id: requestId,
          payload: payload
        },
        scribeOrigin
      );
    }

    function onMessage(event) {
      if (event.origin !== scribeOrigin) return;
      var data = event.data;
      if (!data || data.source !== SCRIBE_SOURCE) return;

      if (data.type === 'ready') {
        if (data.handoff_id !== handoffId) return;
        connected = true;
        sendRequest();
        return;
      }

      if (data.type === 'ack') {
        // Scribe replays acks on retry; only the first is surfaced.
        if (data.request_id !== requestId || acked) return;
        acked = true;
        if (data.status === 'created') {
          emit('onAck', { session_id: data.session_id });
        } else {
          fail(data.error.code, data.error.message);
        }
        return;
      }

      // Scribe stamps the owning handoff on session-bound events; a stale window
      // replaying an older handoff's events must not reach this call's callbacks.
      if (data.handoff_id && data.handoff_id !== handoffId) return;

      if (data.type === 'status') {
        emit('onStatus', { session_id: data.session_id, phase: data.phase });
        return;
      }

      if (data.type === 'published') {
        emit('onPublish', { session_id: data.session_id, documents: data.documents });
      }
    }

    // Call from a click handler; browsers block window.open otherwise.
    function createSession(request) {
      var req = request || {};

      handoffId = randomId('hnd');
      requestId = randomId('req');
      connected = false;
      requestSent = false;
      acked = false;
      deadline = Date.now() + CONNECT_TIMEOUT_MS;
      callbacks = {
        onAck: req.onAck,
        onStatus: req.onStatus,
        onPublish: req.onPublish,
        onError: req.onError,
        onClose: req.onClose
      };
      // Explicit whitelist: anything not listed here never leaves this page.
      payload = {
        session_id: req.session_id,
        templates: req.templates,
        language_hint: req.language_hint,
        patient_details: req.patient_details,
        additional_data: req.additional_data
      };

      if (!listening) {
        window.addEventListener('message', onMessage);
        listening = true;
      }

      // Never re-navigate a Scribe window that is already open: window.open with a
      // url would reload it, destroying an in-flight recording before Scribe ever
      // gets the chance to answer session_in_progress. Reuse it and let the guard
      // on the Scribe side decide.
      if (!popup || popup.closed) {
        // A named window makes a repeat call reuse the same tab.
        popup = window.open(scribeOrigin + embedPath, windowName, windowFeatures);
        if (!popup) {
          fail('popup_blocked', 'Scribe could not be opened. Allow popups for this site.');
          return null;
        }
      }
      try {
        popup.focus();
      } catch (e) {
        // cross-origin focus can throw; harmless
      }

      stopPump();
      pump();

      return { handoff_id: handoffId, request_id: requestId };
    }

    function destroy() {
      stopPump();
      if (listening) {
        window.removeEventListener('message', onMessage);
        listening = false;
      }
      popup = null;
      callbacks = {};
    }

    return { createSession: createSession, destroy: destroy };
  }

  var defaultClient = null;

  window.EkaScribe = {
    init: function (options) {
      return createClient(options);
    },
    createSession: function (request) {
      if (!defaultClient) defaultClient = createClient();
      return defaultClient.createSession(request);
    },
    destroy: function () {
      if (defaultClient) defaultClient.destroy();
      defaultClient = null;
    }
  };
})();

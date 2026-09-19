# Partner embed integration

Lets a third-party web page start a Scribe session and receive the resulting note info back,
without either side hosting the other.

## Shape of the integration

The partner page loads `scribe-embed.js` from the Scribe host. Calling
`EkaScribe.createSession(...)` opens Scribe in a **new window** and hands the payload over a
`postMessage` channel. The partner page stays alive throughout and receives events as real
JS callbacks.

```
partner page  ──window.open──▶  Scribe popup
      │                              │
      └──────  postMessage  ─────────┘
```

**The partner holds the payload until Scribe asks for it.** After opening the popup the script
sends a `hello` every 300ms and waits for `ready`. Scribe only answers `ready` once the doctor
is signed in. If the doctor has to log in — including a full SSO round-trip that navigates the
popup away and back — nothing is lost, because the payload never left the partner's page.
Once connected the pings drop to one every 3s, which also re-establishes the channel if the
Scribe window is reloaded.

Scribe always replies to `event.source` / `event.origin`, never to `window.opener`, so the
channel survives an opener reference being severed by the auth round-trip.

## Partner API

```html
<script src="https://<scribe-host>/scribe-embed.js"></script>
<script>
  document.querySelector('#start').addEventListener('click', function () {
    EkaScribe.createSession({
      // ---- all optional ----
      session_id: 'sc-abc123def456789',     // 16–32 chars; Scribe generates one if omitted
      templates: ['tmpl_soap'],             // max 2, must exist in the doctor's workspace
      language_hint: ['auto_detect'],       // or ['en-IN','hi']
      patient_details: {                    // mobile must be a NUMBER
        oid: 'pat-1', name: 'A B', age: '34', gender: 'M', mobile: 9999999999
      },
      additional_data: {                    // free-form; every key is stored and returned
        title: 'Follow-up — A B',           // also becomes the session's editable title
        attendees: 'Dr Mehta, A B',
        appointment_id: 'appt_1'            // your own references live here
      },

      // ---- callbacks, all optional ----
      onAck:     function (r) { /* { session_id }                       — session created   */ },
      onStatus:  function (r) { /* { session_id, phase }                — phase changed     */ },
      onPublish: function (r) { /* { session_id, documents: [...] }      — doctor published  */ },
      onError:   function (e) { /* { code, message }                    — see Errors below  */ },
      onClose:   function ()  { /* the Scribe window was closed                             */ }
    });
    // returns { handoff_id, request_id }, or null if the popup was blocked
  });
</script>
```

`createSession` must be called from a user gesture (a click) — browsers block `window.open`
otherwise, and the script reports `popup_blocked`.

`EkaScribe.init({ scribeOrigin, embedPath, windowName, windowFeatures })` returns an isolated
client if the defaults don't fit. By default `scribeOrigin` is the origin the script itself was
served from, so there is nothing to configure.

## What the partner controls

| Field | Effect |
|---|---|
| `session_id` | Used as-is. Must be 16–32 chars or the API rejects it. Omit and Scribe generates `sc-…`. The `onAck` id is authoritative — the server may return a different one. |
| `templates` | Overrides the doctor's saved output templates for this session only. **Max 2**, and each id must exist in that doctor's workspace (`GET /voice/api/v1/template`). |
| `language_hint` | Overrides the doctor's saved input languages for this session only. `['auto_detect']` is sent to the API as `en-hi` (code-mixed) — the backend does no true auto-detection. Valid codes: `en, hi, en-hi, en-IN, en-US, gu, kn, ml, ta, te, bn, mr, pa`. |
| `additional_data` | Stored on the session verbatim — **every key reaches the backend** and comes back on session fetch. The only free-form channel; keep partner references (appointment id, patient id) here. |
| `additional_data.attendees` | Shown in Scribe beside the title, where the doctor can edit it. Saved back to `additional_data.attendees`. |
| `additional_data.callback_url` | On publish, Scribe opens this url in a **new tab** with `session_id`, and a `doc_url` + `document_id` pair per document, appended as query params. http(s) only. Because it is stored on the session, publishing an old session days later still lands there. When set, it replaces the `onPublish` callback. |
| `additional_data.title` | Also applied as the session's own title: it appears in Scribe's title field and the doctor can edit it. Copied, not moved — it stays in `additional_data` too. |
| `patient_details` | `oid`, `name`, `age`, `gender`, `mobile` (a **number**). The backend declares no such field and drops it, so Scribe also copies it into `additional_data.patient_details`, which does persist — you get it back on session fetch either way. A numeric `mobile` sent as a string is coerced, because the SDK's zod check would otherwise fail the whole create. |

Model and consultation mode always come from the doctor's own preferences.

### Where each field actually lands

The create API honours `additional_data` but **ignores `session_details`**, so the title
cannot be set in the create call — Scribe PATCHes it immediately after the session exists,
which is the same route the doctor's own title edits take. That means a partner title
appears a moment after the session opens, not at the instant it is created.

## Events

`onStatus` fires on every phase change: `idle`, `recording`, `paused`, `processing`, `output`,
`error`. Recording is started, paused and ended by the doctor in Scribe — the partner cannot
drive it remotely.

`onPublish` fires when the doctor clicks **Publish** on a generated note. The payload carries
document *info*, not content:

```json
{
  "session_id": "sc-abc123",
  "documents": [
    {
      "document_id": "doc_1",
      "document_name": "SOAP note",
      "template_id": "tmpl_soap",
      "document_type": "notes",
      "type": "markdown",
      "status": "success",
      "errors": [],
      "warnings": [],
      "presigned_url": "https://…"
    }
  ]
}
```

Presigned urls are minted fresh at publish time. Fetch the content from them; they expire.

### Reading a published note

Scribe hands over the **url only**, never the note content — fetch it yourself, ideally
server-side. `presigned_url` does not serve readable text either: note bodies are stored
base64-encoded, so decode after fetching:

```js
function decodeUnicodeBase64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

const raw  = await fetch(doc.presigned_url).then(r => r.text());
const text = decodeUnicodeBase64(raw);
```

Transcripts are the exception — those come back as plain text, no decode. Urls are minted at
publish time and expire, so fetch them promptly rather than storing them.

Note that the blob endpoint does not send CORS headers, so a browser `fetch()` from the
partner's own origin fails. Fetch these urls from the partner's backend.

### Two ways to receive the notes

| | `onPublish` callback | `additional_data.callback_url` |
|---|---|---|
| Delivery | JS function in the EMR page | new tab at `<url>?session_id=…&doc_url=…` |
| EMR page must still be open | yes | no |
| Works for a session published days later | no | yes |
| Set up | pass the function | put the url in `additional_data` |

`callback_url` wins when both are set.

## Errors

| Code | Meaning |
|---|---|
| `session_in_progress` | A session is recording, paused or processing. No second session is created. |
| `session_awaiting_publish` | The previous session has generated notes the doctor hasn't published yet. Once published, a new session is allowed. |
| `create_session_failed` | Scribe reached the API but could not create the session. |
| `scribe_not_ready` | Scribe answered before its lifecycle was wired up. Retry. |
| `invalid_request` | The message was missing `request_id` or `handoff_id`. |
| `popup_blocked` | `window.open` was blocked — call from a click handler. |
| `connect_timeout` | Scribe did not answer within 10 minutes (the doctor never signed in). |

## Guarantees

- **One session at a time.** Inbound commands run through a serialized chain, so two messages
  in the same tick cannot both pass the phase guard.
- **Repeat calls are safe.** Each request carries a `request_id`; a repeat is answered with the
  original ack rather than re-run. Across a popup reload the same handoff is recognised from
  the session's own stored context, so it re-acks instead of erroring.
- **No stale closures.** The channel is a module singleton that reads store state at call time
  and reaches React only through refs.
- **A live Scribe window is never re-navigated.** A second `createSession()` while the popup is
  open reuses that window and lets the Scribe-side guard answer `session_in_progress`; it does
  not reload the popup, which would have destroyed an in-flight recording.

## Security

**The trigger is open.** Any page that loads the script can ask a signed-in doctor's Scribe to
start a session. A client-side allowlist would not fix this — it ships in the public bundle — so
if partners need gating it belongs on the server, keyed to the partner rather than to the origin
string. Until then, the doctor's own window is the gate: nothing happens without a signed-in
Scribe, and the doctor sees the session appear.

**Session-bound events are origin-bound.** `status` and `published` are sent only to the origin
recorded in that session's own `partner_context`, and carry the `handoff_id` that started it, so
one partner can never receive another partner's notes even when several pages are talking to the
same Scribe window.

**Liveness.** Scribe treats the partner as connected only while its `hello` keepalive keeps
arriving (3s interval, 10s window). If the EMR page reloaded or navigated away, Publish fails
loudly instead of posting into a window that no longer listens.

## Code map

| Path | Role |
|---|---|
| `public/scribe-embed.js` | The partner-side script. No build step. |
| `src/features/partner-session/handoff-channel.ts` | Channel singleton: peer, dedup, guards. |
| `src/features/partner-session/hooks/use-partner-bridge.ts` | Mounts the channel, mirrors phase as status. |
| `src/features/partner-session/hooks/use-publish-to-partner.ts` | The Publish action. |
| `src/app/embed/page.tsx` | Popup landing page. |

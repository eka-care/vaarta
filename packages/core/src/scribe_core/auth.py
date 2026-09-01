"""Auth for the on-prem stack: ONE mode — real cookie/JWT login, everywhere.

voice2rx-be has no auth code — AWS API Gateway used to inject a pre-verified
``jwt-payload`` JSON header. On-prem, ``CookieAuthMiddleware`` verifies the
session (cookie or Bearer) and injects that header itself, so all forked
handlers keep working unchanged. ``Principal`` is the ONE typed dependency
that replaces the three inconsistent header-parsing paths during the port.

There is deliberately no AUTH_MODE switch: local dev, tests-in-a-browser and
production all go through the same username/password (or SSO provider) login,
so nothing behaves differently on a laptop than in a deployment.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware

from scribe_core.settings import get_settings

import logging

logger = logging.getLogger(__name__)

JWT_PAYLOAD_HEADER = "jwt-payload"


@dataclass(frozen=True)
class Principal:
    """Typed view of the claims the codebase actually consumes (see plan A5)."""

    b_id: str
    uuid: str
    oid: str
    client_id: str | None
    is_paid: bool
    issuer: str

    @classmethod
    def from_jwt_payload(cls, payload: dict) -> "Principal":
        cc = payload.get("cc") or {}
        return cls(
            b_id=payload.get("b-id", ""),
            uuid=payload.get("uuid", ""),
            oid=payload.get("oid", ""),
            client_id=payload.get("c-id"),
            is_paid=cc.get("esc") == 1,
            issuer=payload.get("iss", ""),
        )

    def to_jwt_payload(self) -> dict:
        payload = {
            "b-id": self.b_id,
            "uuid": self.uuid,
            "oid": self.oid,
            "iss": self.issuer,
            "cc": {"esc": 1 if self.is_paid else 0},
        }
        if self.client_id:
            payload["c-id"] = self.client_id
        return payload


def get_principal(request: Request) -> Principal:
    """FastAPI dependency — the single replacement for all header-parsing paths."""
    raw = request.headers.get(JWT_PAYLOAD_HEADER)
    if not raw:
        raise HTTPException(status_code=401, detail="missing identity")
    try:
        return Principal.from_jwt_payload(json.loads(raw))
    except (json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="invalid identity") from exc


# --- Session tokens: cookie/Bearer JWT ----------------------------------------
SESSION_ALGO = "HS256"
def mint_session_token(principal: Principal, sub: str, secret: str, ttl_seconds: int) -> str:
    """Sign the app's identity claims (b-id/uuid/oid/...) into a session JWT."""
    import time
    import jwt

    payload = principal.to_jwt_payload()
    now = int(time.time())
    payload.update({"sub": sub, "iat": now, "exp": now + int(ttl_seconds)})
    return jwt.encode(payload, secret, algorithm=SESSION_ALGO)


def verify_session_token(token: str, secret: str) -> dict:
    """Decode + verify signature and expiry. Raises jwt.PyJWTError on failure."""
    import jwt
    return jwt.decode(token, secret, algorithms=[SESSION_ALGO])




def cookie_domain() -> str | None:
    """AUTH_COOKIE_DOMAIN, sanitized. Values containing whitespace or '#'
    (a pasted inline comment) would crash Set-Cookie header encoding — treat
    them as unset instead of taking logins down."""
    raw = (get_settings().auth_cookie_domain or "").strip()
    if not raw or any(c in raw for c in ' \t#\u2014'):
        return None
    return raw


def principal_from_user(user: dict) -> Principal:
    s = get_settings()
    return Principal(
        b_id=user.get("b_id") or s.workspace_id,
        uuid=user.get("uuid", ""),
        oid=user.get("oid", ""),
        client_id=None,
        is_paid=True,
        issuer=s.auth_issuer,
    )


def _hash_refresh(raw: str) -> str:
    import hashlib

    return hashlib.sha256(raw.encode()).hexdigest()


def issue_refresh_token(username: str, user_uuid: str) -> str:
    """Create + persist an opaque refresh token; returns the raw value."""
    import secrets
    import time

    from scribe_core.db import get_table

    s = get_settings()
    raw = secrets.token_urlsafe(48)
    now = int(time.time())
    get_table("refresh_tokens").put_item(
        {
            "token_hash": _hash_refresh(raw),
            "username": username,
            "uuid": user_uuid,
            "expires_at": now + s.auth_refresh_ttl_seconds,
            "revoked": 0,
            "rotated_at": 0,
            "created_at": now,
        }
    )
    return raw


def revoke_refresh_token(raw: str) -> None:
    import time

    from scribe_core.db import get_table

    if not raw:
        return
    try:
        get_table("refresh_tokens").update_item(
            {"token_hash": _hash_refresh(raw)},
            {"revoked": 1, "rotated_at": int(time.time())},
            require_exists=False,
        )
    except Exception:
        pass


def revoke_all_refresh_tokens(username: str) -> None:
    import time

    from scribe_core.db import get_table

    table = get_table("refresh_tokens")
    for row in table.find([("username", "eq", username)]):
        table.update_item(
            {"token_hash": row["token_hash"]},
            {"revoked": 1, "rotated_at": int(time.time())},
            require_exists=False,
        )


def consume_refresh_token(raw: str, rotate: bool = True):
    """Validate a refresh token; returns (user, new_raw_refresh | None) or None.

    Rotation is issue-then-delete, scoped to the ONE presented token:

    - valid + rotate   -> a replacement token is issued and returned FIRST;
                          the presented token is then deleted (best-effort,
                          inside try/except -- a failed delete must never fail
                          the refresh, the old row just ages out at expiry).
    - replayed/unknown -> None. Only this client is affected: the user's other
                          sessions (web and desktop coexist) keep their own
                          tokens untouched.
    - expired          -> None (the dead row is deleted opportunistically).
    - revoked (logout) -> None.

    Deliberately NO grace window and NO cross-session revocation (2026-09-01):
    a stale desktop replaying a rotated token must cost that desktop a
    re-login, never the user's browser session. The trade: two parallel
    refreshes with the same token race, the loser gets a 401 and retries with
    the winner's cookie -- clients should single-flight their refresh.
    """
    import time
    from scribe_core.db import get_table
    if not raw:
        logger.warning("refresh rejected: no token supplied (empty body field and no cookie)")
        return None
    table = get_table("refresh_tokens")
    token_hash = _hash_refresh(raw)
    row = table.get_item({"token_hash": token_hash})
    if not row:
        logger.warning(
            "refresh rejected: unknown token (never issued, already rotated away, or cleaned up)"
        )
        return None
    now = int(time.time())
    if int(row.get("expires_at", 0)) <= now:
        logger.warning(
            "refresh rejected: token expired %ss ago (user=%s)",
            now - int(row.get("expires_at", 0)), row.get("username", ""),
        )
        try:
            table.delete_item({"token_hash": token_hash})
        except Exception:  # noqa: BLE001 -- cleanup only
            pass
        return None
    if int(row.get("revoked", 0)) == 1:
        logger.warning(
            "refresh rejected: token was revoked by logout (user=%s)",
            row.get("username", ""),
        )
        return None

    user = get_table("users").get_item({"username": row.get("username", "")}) or {}
    if not user or not user.get("is_active", True):
        logger.warning(
            "refresh rejected: user missing or inactive (user=%s)",
            row.get("username", ""),
        )
        return None

    if not rotate:
        return user, None
    new_raw = issue_refresh_token(user["username"], user.get("uuid", ""))
    try:
        table.delete_item({"token_hash": token_hash})
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "rotated refresh token could not be deleted (user=%s): %s -- "
            "it stays valid until its expiry",
            row.get("username", ""), exc,
        )
    return user, new_raw


class CookieAuthMiddleware(BaseHTTPMiddleware):
    """The auth middleware — the same in dev, test and production.

    Verifies the session JWT from the auth cookie (or an ``Authorization:
    Bearer`` header for programmatic clients), then injects the verified
    claims as the ``jwt-payload`` header — the exact contract every handler
    already consumes, so the rest of the app is untouched. Any caller-supplied
    ``jwt-payload`` header is stripped first (it is an internal, post-auth
    header — trusting it would be an auth bypass).
    """

    EXEMPT_PREFIXES = (
        "/voice/ping",
        # discovery MUST be publicly accessible (alliance SDK validates against it)
        "/.well-known",
        "/voice/v1/.well-known",
        "/docs",
        "/openapi.json",
        "/healthz",
        # blob endpoints authenticate with their own HMAC URL tokens
        # (the alliance SDK sends storage requests with attachAuth: false)
        "/voice/v1/blob",
        "/connect-auth/v1/auth-mode",
        # provider-scoped SSO flows (/{oidc|oauth}/{provider}/…) are mounted
        # at the app root, OUTSIDE API_PREFIXES, so they are exempt by
        # construction; listed here anyway so the exemption survives if
        # API_PREFIXES ever grows.
        "/oidc/",
        "/oauth/",
        "/connect-auth/v1/login",
        "/connect-auth/v1/signup",
        "/connect-auth/v1/logout",
        "/connect-auth/v1/refresh",
        "/connect-auth/v1/account/logout",
        "/connect-auth/v1/account/refresh-token",
        # device authorization flow (RFC 8628): the desktop calls these two
        # WITHOUT a session. NOTE: exact paths, not "/device" — the approve
        # endpoint must stay behind the session cookie.
        "/connect-auth/v1/device/code",
        "/connect-auth/v1/device/token",
    )
    # everything the API owns lives under these prefixes; any other path is a
    # static web-UI asset (HTML shells, JS chunks — no data) and needs no token.
    API_PREFIXES = ("/voice", "/connect-auth")
    async def dispatch(self, request: Request, call_next):
        # never trust an externally supplied identity header
        if request.headers.get(JWT_PAYLOAD_HEADER):
            headers = request.headers.mutablecopy()
            del headers[JWT_PAYLOAD_HEADER]
            request.scope["headers"] = headers.raw

        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path
        if path.startswith(self.EXEMPT_PREFIXES) or not path.startswith(self.API_PREFIXES):
            return await call_next(request)

        s = get_settings()
        bearer = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        cookie_token = request.cookies.get(s.auth_cookie_name, "")
        token = bearer or cookie_token or request.query_params.get("token", "")
        source = "bearer" if bearer else ("cookie" if cookie_token else "query")

        import jwt as pyjwt
        from starlette.responses import JSONResponse

        if not token:
            recovered = await self._on_browser_auth_failure(request, call_next)
            if recovered is not None:
                return recovered
            return JSONResponse({"detail": "missing_token"}, status_code=403)

        try:
            claims = verify_session_token(token, s.auth_jwt_secret or "")
        except pyjwt.ExpiredSignatureError:
            if source == "cookie": 
                # browser path: transparently refresh, keep the app working
                result = consume_refresh_token(
                    request.cookies.get(s.auth_refresh_cookie_name, "")
                )
                if result:
                    user, new_refresh = result
                    principal = principal_from_user(user)
                    new_access = mint_session_token(
                        principal,
                        sub=user["username"],
                        secret=s.auth_jwt_secret or "",
                        ttl_seconds=s.auth_access_ttl_seconds,
                    )
                    claims = verify_session_token(new_access, s.auth_jwt_secret or "")
                    headers = request.headers.mutablecopy()
                    headers[JWT_PAYLOAD_HEADER] = json.dumps(claims)
                    request.scope["headers"] = headers.raw
                    response = await call_next(request)
                    cookie_kwargs = dict(
                        max_age=s.auth_refresh_ttl_seconds,
                        httponly=True,
                        secure=s.auth_cookie_secure,
                        samesite="lax",
                        domain=cookie_domain(),
                        path="/",
                    )
                    response.set_cookie(s.auth_cookie_name, new_access, **cookie_kwargs)
                    if new_refresh:
                        response.set_cookie(
                            s.auth_refresh_cookie_name, new_refresh, **cookie_kwargs
                        )
                    return response
            if source == "cookie":
                recovered = await self._on_browser_auth_failure(request, call_next)
                if recovered is not None:
                    return recovered
                # browser with a dead refresh token: nothing can cure this
                # request -> 403: redirect to login
                return JSONResponse({"detail": "session_expired"}, status_code=403)
            # bearer/native path: 401 -> client calls /refresh and retries
            return JSONResponse({"detail": "token_expired"}, status_code=401)
        except pyjwt.PyJWTError:
            if source == "cookie":
                recovered = await self._on_browser_auth_failure(request, call_next)
                if recovered is not None:
                    return recovered
            # bad signature / malformed -> hard logout signal
            return JSONResponse({"detail": "invalid_token"}, status_code=403)

        headers = request.headers.mutablecopy()
        headers[JWT_PAYLOAD_HEADER] = json.dumps(claims)
        request.scope["headers"] = headers.raw
        return await call_next(request)

    async def _on_browser_auth_failure(self, request: Request, call_next):
        """A browser navigating without a session goes to the login page
        (?next= so deep links survive); XHR/SSE fall through to the JSON 403
        and the frontend redirects itself."""
        from urllib.parse import quote

        from starlette.responses import RedirectResponse

        accepts_html = "text/html" in (request.headers.get("accept") or "")
        if request.method == "GET" and accepts_html:
            target = request.url.path
            if request.url.query:
                target = f"{target}?{request.url.query}"
            return RedirectResponse(
                f"/auth/login?next={quote(target, safe='')}", status_code=302
            )
        return None

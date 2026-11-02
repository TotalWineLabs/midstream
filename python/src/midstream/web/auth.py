"""WebView handlers for signing in and out, sessions, changing your own password, and accepting an
invitation.

Signing in is answered at once: the password, or what an identity provider vouched for, is checked
here, and the session token is issued here, so nothing waits on an agent - except the first sign-in
of someone a domain makes an account for, or of someone it invited, which waits until the account is
theirs. What happened is still published - a sign-in, a failed attempt, a renewal, a sign-out, a
provider account linked, an account made or an invitation accepted - and the identity agent records
it: the session, the person's activity, the failed-attempt count that leads to a lockout, the audit
log.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
from typing import Any
from uuid import uuid4

from midstream.config import ControlPlaneConfig, email_domain_allowed, get_config
from midstream.identity.authorization import (
    authenticate,
    authorize,
    directory_ready,
    request_context,
    require_directory_ready,
)
from midstream.identity.invitations import read_invitation_link, same_link
from midstream.identity.passwords import (
    PASSWORD_MAX_LENGTH,
    PasswordHashingBusy,
    hash_password_async,
    password_problem,
    verify_password_async,
)
from midstream.identity.principals import Principal, cached_grants, grants_for_user, guest_principal
from midstream.identity.providers import (
    PROVIDER_IDS,
    ExternalAccount,
    ProviderError,
    ProviderSettings,
    get_provider_settings,
    verify_credential,
)
from midstream.identity.secrets import IdentitySecrets, get_identity_secrets
from midstream.identity.tokens import SessionClaims, issue_token
from midstream.identity.validation import EMAIL_MAX_LENGTH, IdentityValidationError, clean_person_name
from midstream.models.identity import IdentityRequest, RequestContext, Session, User
from midstream.settings import resolve_config
from midstream.storage.identity import (
    find_user_by_email,
    find_user_by_external_identity,
    get_request_outcome,
    get_sign_in_guard,
    get_user,
    iter_user_sessions,
    normalize_email,
)
from midstream.storage.table import TableProtocol
from midstream.web.errors import WebError, invalid_request, not_found, too_many_requests, unauthenticated

#: How long the first sign-in of someone a domain makes an account for, or invited, waits for the
#: account to be theirs.
PROVISION_WAIT_SECONDS = 10.0
_PROVISION_POLL_SECONDS = 0.1

_INVALID_CREDENTIALS = "Email or password is incorrect."
_HASHING_BUSY = "Too many passwords are being checked at once. Try again in a moment."


@dataclass(frozen=True, slots=True)
class AuthResult:
    """A response whose status the view picks, and the event it publishes, if any."""

    status: int
    body: dict[str, Any]
    request_event: IdentityRequest | None = None
    #: An account this sign-in makes, which the view waits for before it answers: `{user_id, request_id}`.
    provisioning: dict[str, str] | None = None

    def to_value(self) -> dict[str, Any]:
        """The value the WebView pipeline carries to its send and response steps."""
        return {
            "status": self.status,
            "body": self.body,
            "request_event": None if self.request_event is None else self.request_event.to_dict(),
            "provisioning": self.provisioning,
        }


@dataclass(frozen=True, slots=True)
class PasswordChangeAcceptance:
    """The 202 response to a password change, and the request that applies it."""

    response: dict[str, Any]
    request_event: IdentityRequest


async def sign_in(
    directory_table: TableProtocol | None,
    body: Any,
    *,
    request: Any = None,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    secrets: IdentitySecrets | None = None,
    providers: ProviderSettings | None = None,
    http: Any = None,
    now: int | None = None,
) -> AuthResult:
    """Start a session: with an email and password, or with what an identity provider vouched for.

    `{"email", "password"}` checks a password. Answers 200 with the session token; 401 for a wrong
    email or password, saying no more than that; 403 for a deactivated account, which only someone
    who knows its password learns, and 403 `password_sign_in_disabled` where only administrators may
    use one; 429 while the email is locked out.

    `{"provider", "credential", "nonce"}` checks a provider's sign-in (handbook 20; `sso_sign_in`).

    Either answers 503 when this deployment has no signing key, or while it is starting and has not
    read its directory back yet.
    """
    cfg = resolve_config(settings_table) if config is None else config
    identity_secrets = get_identity_secrets() if secrets is None else secrets
    current = _now() if now is None else now
    context = request_context(request) if request is not None else RequestContext()
    if not identity_secrets.can_sign_in:
        return AuthResult(
            503,
            _error(
                "unavailable",
                "Sign-in is not configured on this control plane: it has no session signing key.",
                reason="sign_in_unavailable",
            ),
        )
    if not directory_ready(directory_table):
        # A person not read back yet would be told their password is wrong, and counted for it.
        return AuthResult(
            503,
            _error(
                "unavailable",
                "The control plane is starting and still reading its tables back. Try again in a moment.",
                reason="starting",
            ),
        )
    if not isinstance(body, dict):
        return AuthResult(400, invalid_request("request body must be an object").to_response())
    if body.get("provider") not in (None, "password"):
        return await sso_sign_in(
            directory_table,
            body,
            config=cfg,
            secrets=identity_secrets,
            providers=get_provider_settings() if providers is None else providers,
            http=http,
            context=context,
            now=current,
        )
    raw_email = body.get("email")
    password = body.get("password")
    if not isinstance(raw_email, str) or not raw_email.strip():
        return AuthResult(400, invalid_request("Enter your email", field_name="email").to_response())
    if not isinstance(password, str) or not password:
        return AuthResult(400, invalid_request("Enter your password", field_name="password").to_response())
    email = normalize_email(raw_email)
    if len(email) > EMAIL_MAX_LENGTH or len(password) > PASSWORD_MAX_LENGTH:
        return AuthResult(401, unauthenticated(_INVALID_CREDENTIALS, reason="invalid_credentials").to_response())

    guard = get_sign_in_guard(directory_table, email)
    locked_until = _parse_time(None if guard is None else guard.locked_until)
    if locked_until is not None and locked_until > current:
        minutes = max(1, (locked_until - current + 59) // 60)
        return AuthResult(
            429,
            _error(
                "too_many_attempts",
                f"Too many failed sign-ins. Try again in {minutes} minute{'s' if minutes != 1 else ''}, "
                "or ask an administrator to unlock your account.",
                reason="locked_out",
                retry_after=locked_until - current,
            ),
        )

    user = find_user_by_email(directory_table, email)
    encoded = None if user is None or user.password is None else user.password.hash
    try:
        verified = await verify_password_async(password, encoded)
    except PasswordHashingBusy:
        return AuthResult(
            429,
            _error("too_many_attempts", "Too many sign-ins at once. Try again in a moment.", reason="busy"),
        )
    if not verified:
        reason = "unknown_email" if user is None else ("no_password" if user.password is None else "wrong_password")
        return AuthResult(
            401,
            unauthenticated(_INVALID_CREDENTIALS, reason="invalid_credentials").to_response(),
            _event(
                "sign_in_failed",
                actor_id=user.user_id if user is not None else "anonymous",
                actor_email=email,
                payload={"email": email, "reason": reason},
                context=context,
                now=current,
            ),
        )
    if not user.active:
        return AuthResult(
            403,
            _error(
                "forbidden",
                "This account is deactivated. Ask an administrator to reactivate it.",
                reason="account_deactivated",
            ),
            _event(
                "sign_in_failed",
                actor_id=user.user_id,
                actor_email=email,
                payload={"email": email, "reason": "deactivated"},
                context=context,
                now=current,
            ),
        )
    if not cfg.password_sign_in_enabled and not cached_grants(directory_table, user).all_permissions:
        # Checked once the password is: whoever learns it here knew the password already. An
        # administrator may always use one, so the first administrator can always get in.
        return AuthResult(
            403,
            _error(
                "forbidden",
                "Password sign-in is turned off here. Sign in with your company account.",
                reason="password_sign_in_disabled",
            ),
            _event(
                "sign_in_failed",
                actor_id=user.user_id,
                actor_email=email,
                payload={"email": email, "reason": "password_sign_in_disabled", "method": "password"},
                context=context,
                now=current,
            ),
        )

    session_expires_at = current + cfg.session_max_lifetime_hours * 3600
    claims = SessionClaims(
        session_id=f"ses-{uuid4().hex[:16]}",
        user_id=user.user_id,
        session_epoch=user.session_epoch,
        issued_at=current,
        expires_at=min(current + cfg.session_idle_timeout_minutes * 60, session_expires_at),
        session_expires_at=session_expires_at,
        signed_in_at=current,
        method="password",
    )
    principal = Principal(
        kind="user",
        grants=cached_grants(directory_table, user),
        user_id=user.user_id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        session_id=claims.session_id,
        session_expires_at=claims.session_expires_at,
        expires_at=claims.expires_at,
        issued_at=claims.issued_at,
        signed_in_at=claims.signed_in_at,
        sign_in_method=claims.method,
        password_change_required=user.must_change_password,
    )
    return AuthResult(
        200,
        session_payload(principal, config=cfg, token=issue_token(claims, identity_secrets)),
        _event(
            "sign_in_succeeded",
            actor_id=user.user_id,
            actor_email=user.email,
            payload={
                "session_id": claims.session_id,
                "user_id": user.user_id,
                "method": claims.method,
                "created_at": _iso(current),
                "expires_at": _iso(claims.session_expires_at),
            },
            context=context,
            now=current,
        ),
    )


async def sso_sign_in(
    directory_table: TableProtocol | None,
    body: dict[str, Any],
    *,
    config: ControlPlaneConfig,
    secrets: IdentitySecrets,
    providers: ProviderSettings,
    http: Any,
    context: RequestContext,
    now: int,
) -> AuthResult:
    """Start a session with what an identity provider vouched for (handbook 20).

    The provider's credential is checked here, against its keys or API. The person is then found:
    by the provider account, linked before; else by the email the provider vouches for, and linked
    to it from then on - an invitation for that email is accepted, under either policy; else, under
    the `open` first-sign-in policy, an account is made for them.
    Refusals: 403 `provider_disabled`, `email_not_allowed`, `email_unverified`, `no_account`,
    `account_deactivated`; 401 `invalid_credential`; 503 `provider_unreachable`.
    """
    provider = body.get("provider")
    if provider not in PROVIDER_IDS:
        return AuthResult(400, invalid_request(f"provider must be one of: {', '.join(PROVIDER_IDS)}", field_name="provider").to_response())
    label = providers.label(provider)
    if not providers.configured(provider) or not getattr(config, f"sso_{provider}_enabled"):
        return AuthResult(
            403,
            _error("forbidden", f"Signing in with {label} is not turned on here.", reason="provider_disabled"),
        )
    try:
        account = await verify_credential(provider, body.get("credential"), body.get("nonce"), settings=providers, http=http, now=now)
    except ProviderError as error:
        code = {401: "unauthenticated", 403: "forbidden", 503: "unavailable"}.get(error.status, "forbidden")
        refused = None
        if error.reason in ("email_unverified", "email_not_allowed"):
            refused = _sso_refusal(provider, None, error.reason, context=context, now=now)
        return AuthResult(error.status, _error(code, error.message, reason=error.reason), refused)

    method = f"sso:{provider}"
    if not email_domain_allowed(account.email, config.sso_allowed_email_domains):
        return AuthResult(
            403,
            _error("forbidden", f"{account.email} may not sign in here: its email domain is not allowed.", reason="email_not_allowed"),
            _sso_refusal(provider, account, "email_not_allowed", context=context, now=now),
        )

    user = find_user_by_external_identity(directory_table, provider, account.subject)
    action = "sign_in_succeeded"
    if user is None:
        user = find_user_by_email(directory_table, account.email)
        if user is not None:
            action = "accept_invitation" if user.invited else "link_identity"
    if user is not None and user.status == "deactivated":
        return AuthResult(
            403,
            _error("forbidden", "This account is deactivated. Ask an administrator to reactivate it.", reason="account_deactivated"),
            _sso_refusal(provider, account, "deactivated", context=context, now=now, user=user),
        )
    if user is None:
        if config.sso_first_sign_in != "open":
            return AuthResult(
                403,
                _error(
                    "forbidden",
                    f"{account.email} has no account here. Ask an administrator to add you, then sign in again.",
                    reason="no_account",
                ),
                _sso_refusal(provider, account, "no_account", context=context, now=now),
            )
        action = "provision_user"
        user = _provisioned_user(account, now=now)

    session_expires_at = now + config.session_max_lifetime_hours * 3600
    claims = SessionClaims(
        session_id=f"ses-{uuid4().hex[:16]}",
        user_id=user.user_id,
        session_epoch=user.session_epoch,
        issued_at=now,
        expires_at=min(now + config.session_idle_timeout_minutes * 60, session_expires_at),
        session_expires_at=session_expires_at,
        signed_in_at=now,
        method=method,
    )
    principal = Principal(
        kind="user",
        # Someone not in the directory yet has the grants every signed-in person has.
        grants=grants_for_user(directory_table, user) if action == "provision_user" else cached_grants(directory_table, user),
        user_id=user.user_id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        session_id=claims.session_id,
        session_expires_at=claims.session_expires_at,
        expires_at=claims.expires_at,
        issued_at=claims.issued_at,
        signed_in_at=claims.signed_in_at,
        sign_in_method=method,
    )
    payload: dict[str, Any] = {
        "session_id": claims.session_id,
        "user_id": user.user_id,
        "method": method,
        "created_at": _iso(now),
        "expires_at": _iso(claims.session_expires_at),
    }
    if action != "sign_in_succeeded":
        payload["provider"] = provider
        payload["subject"] = account.subject
    if action in ("provision_user", "accept_invitation"):
        payload.update(email=account.email, first_name=account.first_name, last_name=account.last_name)
    event = _event(action, actor_id=user.user_id, actor_email=user.email, payload=payload, context=context, now=now)
    return AuthResult(
        200,
        session_payload(principal, config=config, token=issue_token(claims, secrets), providers=providers),
        event,
        # The session is the account's once the agent has made it, or made the invitation theirs.
        provisioning={"user_id": user.user_id, "request_id": event.request_id} if action in ("provision_user", "accept_invitation") else None,
    )


def provisioned_user_id(provider: str, subject: str) -> str:
    """The id of an account made at a provider sign-in: the same for the same provider account, so
    two first sign-ins at once make one account."""
    return "usr-" + hashlib.sha256(f"{provider}:{subject}".encode("utf-8")).hexdigest()[:16]


def _provisioned_user(account: ExternalAccount, *, now: int) -> User:
    moment = _iso(now) or ""
    return User(
        user_id=provisioned_user_id(account.provider, account.subject),
        email=account.email,
        first_name=account.first_name,
        last_name=account.last_name,
        created_at=moment,
        created_by=f"sso:{account.provider}",
        updated_at=moment,
        updated_by=f"sso:{account.provider}",
    )


def _sso_refusal(
    provider: str,
    account: ExternalAccount | None,
    reason: str,
    *,
    context: RequestContext,
    now: int,
    user: User | None = None,
) -> IdentityRequest | None:
    """A refused provider sign-in, for the audit log. It never counts towards a lockout: nobody
    guessed anything."""
    if account is None:
        return None
    return _event(
        "sign_in_failed",
        actor_id=user.user_id if user is not None else "anonymous",
        actor_email=account.email,
        payload={"email": account.email, "reason": reason, "method": f"sso:{provider}"},
        context=context,
        now=now,
    )


async def await_provisioned(
    directory_table: TableProtocol | None,
    value: dict[str, Any],
    *,
    timeout: float = PROVISION_WAIT_SECONDS,
) -> dict[str, Any]:
    """Hold the answer to a first sign-in until the account it makes, or the invitation it accepts,
    is the person's: there and active.

    The identity agent makes the account, or accepts the invitation, after the view has published
    the request; until then the session's token would be refused. Answers as the sign-in did once
    the account is theirs; 409 when the agent refused it; 503 when it did not apply it in time, and
    the person signs in again.
    """
    provisioning = value.get("provisioning")
    if not isinstance(provisioning, dict) or value.get("status") != 200:
        return value
    user_id = str(provisioning.get("user_id") or "")
    request_id = str(provisioning.get("request_id") or "")
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        user = get_user(directory_table, user_id)
        if user is not None and user.active:
            return value
        outcome = get_request_outcome(directory_table, request_id)
        if outcome is not None and outcome.status == "rejected":
            return {
                **value,
                "status": 409,
                "body": _error("conflict", outcome.message or "Your account could not be made. Sign in again.", reason=outcome.reason or "rejected"),
            }
        if asyncio.get_running_loop().time() >= deadline:
            return {
                **value,
                "status": 503,
                "body": _error("unavailable", "Your account is still being made. Sign in again in a moment.", reason="provisioning"),
            }
        await asyncio.sleep(_PROVISION_POLL_SECONDS)


def describe_invitation(
    directory_table: TableProtocol | None,
    body: Any,
    *,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    providers: ProviderSettings | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """What an invitation link is for, to the page that opens it (handbook 18 §18.18).

    Body `{"token"}`: the link is the credential, so this needs no session, and says nothing to
    anyone without a link that works now - 404 for one that never did or no longer does, 410 for
    one that expired. Answers the invited email and names, who invited them, until when the link
    works, and how they may accept: with a password, through the providers listed, or both.
    """
    cfg = resolve_config(settings_table) if config is None else config
    require_directory_ready(directory_table)
    if not isinstance(body, dict):
        raise invalid_request("request body must be an object")
    user, _ = invitation_for_link(directory_table, body.get("token"), now=_now() if now is None else now)
    invitation = user.invitation
    assert invitation is not None
    inviter = find_user_by_email(directory_table, invitation.invited_by)
    return {
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "invited_by": inviter.display_name if inviter is not None else invitation.invited_by,
        "invited_at": invitation.invited_at,
        "link_expires_at": invitation.link_expires_at,
        "password_sign_in": _password_accepted(directory_table, user, cfg),
        "providers": [item for item in sign_in_providers(cfg, providers) if item["type"] == "sso"],
        "password_policy": {"min_length": cfg.password_min_length, "max_length": PASSWORD_MAX_LENGTH},
    }


async def accept_invitation(
    directory_table: TableProtocol | None,
    body: Any,
    *,
    request: Any = None,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    secrets: IdentitySecrets | None = None,
    now: int | None = None,
) -> AuthResult:
    """Accept an invitation with its link and a password of one's own, and start a session there.

    Body `{"token", "first_name", "last_name", "password"}`. Whoever holds the link may accept the
    invitation it names, until it expires or a newer link replaces it. Answers 200 with the session
    once the identity agent has made the account theirs (the view waits for it, as for a provider's
    first sign-in); 404 for a link that does not work, 410 for one that expired, 403
    `password_sign_in_disabled` where only administrators may use a password, 400 for a name or a
    password the rules refuse, 503 while sign-in is unavailable.
    """
    cfg = resolve_config(settings_table) if config is None else config
    identity_secrets = get_identity_secrets() if secrets is None else secrets
    current = _now() if now is None else now
    context = request_context(request) if request is not None else RequestContext()
    if not identity_secrets.can_sign_in:
        return AuthResult(
            503,
            _error(
                "unavailable",
                "Sign-in is not configured on this control plane: it has no session signing key.",
                reason="sign_in_unavailable",
            ),
        )
    if not directory_ready(directory_table):
        return AuthResult(
            503,
            _error(
                "unavailable",
                "The control plane is starting and still reading its tables back. Try again in a moment.",
                reason="starting",
            ),
        )
    if not isinstance(body, dict):
        return AuthResult(400, invalid_request("request body must be an object").to_response())
    try:
        user, link_hash = invitation_for_link(directory_table, body.get("token"), now=current)
        if not _password_accepted(directory_table, user, cfg):
            raise WebError(
                code="forbidden",
                message=f"Password sign-in is turned off here. Accept the invitation by signing in with your company account as {user.email}.",
                details={"reason": "password_sign_in_disabled"},
                status_code=403,
            )
        try:
            first_name = clean_person_name(body.get("first_name"), field="first_name", label="First name")
            last_name = clean_person_name(body.get("last_name"), field="last_name", label="Last name")
        except IdentityValidationError as error:
            raise invalid_request(str(error), field_name=error.field) from error
        password = body.get("password")
        problem = password_problem(password, min_length=cfg.password_min_length, email=user.email, first_name=first_name, last_name=last_name)
        if problem is not None:
            raise invalid_request(problem, field_name="password")
        password_hash = await hash_new_password(password)
    except WebError as error:
        return AuthResult(error.status_code, error.to_response())

    session_expires_at = current + cfg.session_max_lifetime_hours * 3600
    claims = SessionClaims(
        session_id=f"ses-{uuid4().hex[:16]}",
        user_id=user.user_id,
        session_epoch=user.session_epoch,
        issued_at=current,
        expires_at=min(current + cfg.session_idle_timeout_minutes * 60, session_expires_at),
        session_expires_at=session_expires_at,
        signed_in_at=current,
        method="password",
    )
    principal = Principal(
        kind="user",
        grants=cached_grants(directory_table, user),
        user_id=user.user_id,
        email=user.email,
        first_name=first_name,
        last_name=last_name,
        session_id=claims.session_id,
        session_expires_at=claims.session_expires_at,
        expires_at=claims.expires_at,
        issued_at=claims.issued_at,
        signed_in_at=claims.signed_in_at,
        sign_in_method=claims.method,
    )
    event = _event(
        "accept_invitation",
        actor_id=user.user_id,
        actor_email=user.email,
        payload={
            "user_id": user.user_id,
            "method": "password",
            "link_hash": link_hash,
            "password_hash": password_hash,
            "first_name": first_name,
            "last_name": last_name,
            "session_id": claims.session_id,
            "created_at": _iso(current),
            "expires_at": _iso(claims.session_expires_at),
        },
        context=context,
        now=current,
    )
    return AuthResult(
        200,
        session_payload(principal, config=cfg, token=issue_token(claims, identity_secrets)),
        event,
        provisioning={"user_id": user.user_id, "request_id": event.request_id},
    )


def invitation_for_link(directory_table: TableProtocol | None, token: Any, *, now: int) -> tuple[User, str]:
    """The invited account a link is for now, and the link's hash; 404 or 410 for a link that does
    not work. Every link that does not work reads the same, whatever is wrong with it."""
    read = read_invitation_link(token)
    user = None if read is None else get_user(directory_table, read[0])
    if read is None or user is None or user.invitation is None or not user.invited or not same_link(user.invitation.link_hash, read[1]):
        error = not_found(
            "This invitation link does not work: a newer link replaced it, or the invitation was revoked "
            "or accepted. Ask whoever invited you for a new link, or sign in.",
            resource="invitation",
            identifier="",
        )
        error.details["reason"] = "invitation_invalid"
        raise error
    expires = _parse_time(user.invitation.link_expires_at)
    if expires is None or expires <= now:
        raise WebError(
            code="gone",
            message="This invitation link has expired. Ask whoever invited you for a new one.",
            details={"reason": "invitation_expired"},
            status_code=410,
        )
    return user, read[1]


def _password_accepted(directory_table: TableProtocol | None, user: User, config: ControlPlaneConfig) -> bool:
    """Whether this person may accept their invitation with a password: wherever password sign-in
    is on, and an invited administrator always, as at sign-in."""
    return config.password_sign_in_enabled or cached_grants(directory_table, user).all_permissions


def refresh_session(
    directory_table: TableProtocol | None,
    request: Any,
    *,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    secrets: IdentitySecrets | None = None,
    now: int | None = None,
) -> AuthResult:
    """Renew the caller's session: a new token whose idle timeout starts again.

    It never outlives the session's maximum length, which is fixed at sign-in.
    """
    cfg = resolve_config(settings_table) if config is None else config
    identity_secrets = get_identity_secrets() if secrets is None else secrets
    current = _now() if now is None else now
    principal = authorize(request, directory_table, None, allow_password_change=True, secrets=identity_secrets, now=current)
    if principal.kind != "user" or principal.session_id is None or principal.session_expires_at is None:
        raise unauthenticated("Sign in to renew a session.", reason="sign_in_required")
    user = get_user(directory_table, principal.user_id or "")
    if user is None:
        raise unauthenticated("Your session is not valid. Sign in again.", reason="invalid_session")
    claims = SessionClaims(
        session_id=principal.session_id,
        user_id=user.user_id,
        session_epoch=user.session_epoch,
        issued_at=current,
        expires_at=min(current + cfg.session_idle_timeout_minutes * 60, principal.session_expires_at),
        session_expires_at=principal.session_expires_at,
        signed_in_at=principal.signed_in_at or current,
        method=principal.sign_in_method or "password",
    )
    renewed = Principal(
        kind="user",
        grants=principal.grants,
        user_id=principal.user_id,
        email=principal.email,
        first_name=principal.first_name,
        last_name=principal.last_name,
        session_id=claims.session_id,
        session_expires_at=claims.session_expires_at,
        expires_at=claims.expires_at,
        issued_at=claims.issued_at,
        signed_in_at=claims.signed_in_at,
        sign_in_method=claims.method,
        password_change_required=principal.password_change_required,
    )
    return AuthResult(
        200,
        session_payload(renewed, config=cfg, token=issue_token(claims, identity_secrets)),
        _event(
            "session_refreshed",
            actor_id=user.user_id,
            actor_email=user.email,
            payload={"session_id": claims.session_id, "user_id": user.user_id},
            context=request_context(request),
            now=current,
        ),
    )


def sign_out(
    directory_table: TableProtocol | None,
    request: Any,
    body: Any = None,
    *,
    secrets: IdentitySecrets | None = None,
    now: int | None = None,
) -> AuthResult:
    """End the caller's session, another of their sessions, or all their others.

    Body `{"scope": "current" | "others" | "session", "session_id": …}`; `current` by default. A
    session that is already unusable is simply reported signed out.
    """
    current = _now() if now is None else now
    try:
        principal = authenticate(request, directory_table, secrets=secrets, now=current)
    except WebError as error:
        if error.status_code >= 500:
            # Not read back yet after a start: whether the session is usable is not known.
            raise
        return AuthResult(200, {"signed_out": True, "scope": "current"})
    if principal.kind != "user":
        return AuthResult(200, {"signed_out": False, "scope": "current"})
    options = body if isinstance(body, dict) else {}
    scope = options.get("scope") or "current"
    if scope not in ("current", "others", "session"):
        raise invalid_request("scope must be current, others or session", field_name="scope")
    target = options.get("session_id")
    if scope == "session" and (not isinstance(target, str) or not target):
        raise invalid_request("session_id is required to sign out another session", field_name="session_id")
    return AuthResult(
        200,
        {"signed_out": True, "scope": scope},
        _event(
            "sign_out",
            actor_id=principal.user_id or "",
            actor_email=principal.email,
            payload={
                "session_id": principal.session_id,
                "scope": scope,
                "target_session_id": target if scope == "session" else None,
                "session_expires_at": principal.session_expires_at,
            },
            context=request_context(request),
            now=current,
        ),
    )


def session_view(
    directory_table: TableProtocol | None,
    request: Any,
    *,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    secrets: IdentitySecrets | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Who the caller is and what they may do — a guest when they have no usable session.

    Never refuses: a session that cannot be used is reported as `session_error`, beside the guest
    the caller now is, so a client can tell an expired session from never having signed in.
    """
    cfg = resolve_config(settings_table) if config is None else config
    try:
        principal = authenticate(request, directory_table, secrets=secrets, now=now)
    except WebError as error:
        if error.status_code >= 500:
            # Still reading the directory back after a start: a session not found yet has not
            # ended, and a client that took it for one would sign its person out.
            raise
        return {
            **session_payload(guest_principal(directory_table), config=cfg),
            "session_error": error.details.get("reason", "invalid_session"),
        }
    return session_payload(principal, config=cfg)


def sign_in_providers(config: ControlPlaneConfig, providers: ProviderSettings | None = None) -> list[dict[str, Any]]:
    """How people may sign in to this domain: with a password - only administrators, while password
    sign-in is off - and through each provider the deployment configured and a setting turned on."""
    settings = get_provider_settings() if providers is None else providers
    offered: list[dict[str, Any]] = [
        {
            "id": "password",
            "type": "password",
            "label": "Email and password",
            "administrators_only": not config.password_sign_in_enabled,
        }
    ]
    for provider in PROVIDER_IDS:
        if settings.configured(provider) and getattr(config, f"sso_{provider}_enabled"):
            offered.append({"id": provider, "type": "sso", "label": settings.label(provider)})
    return offered


def session_payload(
    principal: Principal,
    *,
    config: ControlPlaneConfig | None = None,
    token: str | None = None,
    providers: ProviderSettings | None = None,
) -> dict[str, Any]:
    """A principal and their session as the auth endpoints report them."""
    cfg = get_config() if config is None else config
    payload: dict[str, Any] = {
        "authenticated": principal.kind == "user",
        "principal": principal.describe(),
        "session": None,
        "providers": sign_in_providers(cfg, providers),
        "password_policy": {"min_length": cfg.password_min_length, "max_length": PASSWORD_MAX_LENGTH},
    }
    if principal.kind == "user" and principal.session_id is not None:
        issued = principal.issued_at or principal.signed_in_at or _now()
        payload["session"] = {
            "session_id": principal.session_id,
            "method": principal.sign_in_method,
            "signed_in_at": _iso(principal.signed_in_at),
            "issued_at": _iso(issued),
            "expires_at": _iso(principal.expires_at),
            "session_expires_at": _iso(principal.session_expires_at),
            "refresh_after": _iso(issued + cfg.session_refresh_minutes * 60),
        }
    if token is not None:
        payload["token"] = token
        payload["token_type"] = "Bearer"
    return payload


async def change_password(
    directory_table: TableProtocol | None,
    request: Any,
    body: Any,
    *,
    settings_table: TableProtocol | None = None,
    config: ControlPlaneConfig | None = None,
    accepted_at: str | None = None,
) -> PasswordChangeAcceptance:
    """Replace the caller's password, given their current one.

    Every session of theirs ends once it applies, this one included, so the client signs in again
    with the new password.
    """
    cfg = resolve_config(settings_table) if config is None else config
    principal = authorize(request, directory_table, None, allow_password_change=True)
    if principal.kind != "user":
        raise unauthenticated("Sign in to change your password.", reason="sign_in_required")
    user = get_user(directory_table, principal.user_id or "")
    if user is None:
        raise unauthenticated("Your session is not valid. Sign in again.", reason="invalid_session")
    if not isinstance(body, dict):
        raise invalid_request("request body must be an object")
    current_password = body.get("current_password")
    new_password = body.get("new_password")
    if not isinstance(current_password, str) or not current_password:
        raise invalid_request("Enter your current password", field_name="current_password")
    try:
        verified = len(current_password) <= PASSWORD_MAX_LENGTH and await verify_password_async(
            current_password,
            None if user.password is None else user.password.hash,
        )
    except PasswordHashingBusy as error:
        raise too_many_requests(_HASHING_BUSY, reason="busy") from error
    if not verified:
        raise invalid_request("Your current password is not correct", field_name="current_password")
    problem = password_problem(
        new_password,
        min_length=cfg.password_min_length,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
    )
    if problem is not None:
        raise invalid_request(problem, field_name="new_password")
    if new_password == current_password:
        raise invalid_request("Choose a password different from your current one", field_name="new_password")
    password_hash = await hash_new_password(new_password)
    submitted_at = accepted_at or _iso(_now())
    event = IdentityRequest(
        request_id=f"idr-{uuid4().hex[:12]}",
        action="change_password",
        submitted_at=submitted_at,
        actor_id=user.user_id,
        actor_email=user.email,
        payload={"user_id": user.user_id, "password_hash": password_hash},
        context=request_context(request),
    )
    return PasswordChangeAcceptance(
        response={
            "request_id": event.request_id,
            "action": event.action,
            "entity_type": "user",
            "entity_id": user.user_id,
            "accepted_at": submitted_at,
            "status_url": f"/identity/requests/{event.request_id}",
        },
        request_event=event,
    )


def my_sessions_view(
    directory_table: TableProtocol | None,
    request: Any,
    *,
    now: int | None = None,
) -> dict[str, Any]:
    """The caller's recorded sessions, newest first, marking the one making this request."""
    principal = authorize(request, directory_table, None, allow_password_change=True, now=now)
    if principal.kind != "user":
        raise unauthenticated("Sign in to see your sessions.", reason="sign_in_required")
    current = _now() if now is None else now
    sessions = iter_user_sessions(directory_table, principal.user_id or "")
    return {
        "current_session_id": principal.session_id,
        "sessions": [describe_session(session, current=principal.session_id, now=current) for session in sessions],
    }


async def hash_new_password(password: str) -> str:
    """Hash a password someone is setting, or refuse with 429 while the hashing pool is full."""
    try:
        return await hash_password_async(password)
    except PasswordHashingBusy as error:
        raise too_many_requests(_HASHING_BUSY, reason="busy") from error


def describe_session(session: Session, *, current: str | None, now: int) -> dict[str, Any]:
    """A session as the account pages show it."""
    expires = _parse_time(session.expires_at)
    return {
        "session_id": session.session_id,
        "method": session.method,
        "created_at": session.created_at,
        "last_seen_at": session.last_seen_at,
        "expires_at": session.expires_at,
        "ip": session.ip,
        "user_agent": session.user_agent,
        "current": session.session_id == current,
        "active": not session.ended and (expires is None or expires > now),
        "ended_at": session.ended_at,
        "ended_reason": session.ended_reason,
    }


def _event(
    action: str,
    *,
    actor_id: str,
    actor_email: str | None,
    payload: dict[str, Any],
    context: RequestContext,
    now: int,
) -> IdentityRequest:
    return IdentityRequest(
        request_id=f"idr-{uuid4().hex[:12]}",
        action=action,
        submitted_at=_iso(now),
        actor_id=actor_id or "anonymous",
        actor_email=actor_email,
        payload=payload,
        context=context,
    )


def _error(code: str, message: str, **details: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def _now() -> int:
    return int(datetime.now(tz=UTC).timestamp())


def _iso(epoch: int | None) -> str | None:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_time(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp())

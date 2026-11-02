"""Invitation links (handbook 18 §18.18): what lets an invited person accept with a password of their own.

An invitation is an account made by email before its person signs in, holding the groups and dataset
roles chosen for them. They accept it at their first sign-in: through a provider that vouches for the
invited email, or with the invitation's link, which carries the account's id and a secret:

    inv_<user id>.<secret>      the secret: 32 random bytes, base64url, 43 characters

The directory keeps only the secret's SHA-256 (`Invitation.link_hash`) and when the link stops
working, so neither the identity topic nor the directory's changelog holds anything a link could be
made from. The secret has 256 bits, so a plain hash is enough: there is nothing to guess. The console
puts each domain's token after `#` in the one link it shows a person, `<console>/invitation#<domain>:<token>,…`,
so none reaches a server's log or a referrer; its page hands each to its own domain in a request body.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import re
import secrets
from typing import Any

INVITATION_LINK_PREFIX = "inv_"
#: The most people one request may invite.
MAX_INVITATIONS = 100

_SECRET_BYTES = 32
_TOKEN = re.compile(r"^inv_([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.([A-Za-z0-9_-]{43})$")
_HASH = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class InvitationLink:
    """A new link: its token, shown once to whoever invited and never stored, and the hash that is."""

    token: str
    link_hash: str


def new_invitation_link(user_id: str) -> InvitationLink:
    """A link for one invited account, with a secret no earlier link shares."""
    secret = secrets.token_urlsafe(_SECRET_BYTES)
    return InvitationLink(token=f"{INVITATION_LINK_PREFIX}{user_id}.{secret}", link_hash=secret_hash(secret))


def read_invitation_link(token: Any) -> tuple[str, str] | None:
    """The account a link is for and its secret's hash, or None for text that is not a link."""
    if not isinstance(token, str):
        return None
    match = _TOKEN.match(token.strip())
    if match is None:
        return None
    return match.group(1), secret_hash(match.group(2))


def secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def is_link_hash(value: Any) -> bool:
    return isinstance(value, str) and _HASH.match(value) is not None


def same_link(stored: str | None, presented: str | None) -> bool:
    """Whether a presented link is the one an invitation holds now, compared in constant time."""
    if stored is None or presented is None:
        return False
    return hmac.compare_digest(stored.encode("ascii"), presented.encode("ascii"))

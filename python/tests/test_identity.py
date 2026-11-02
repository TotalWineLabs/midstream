"""People, groups, roles, sessions and permissions: the catalog, the agent, the API and authorization."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
import threading
from typing import Any
import unittest

from midstream.config import ControlPlaneConfig
from midstream.identity.authorization import authenticate, authorize, bearer_token, directory_ready, request_context
from midstream.identity.directory import DirectoryView
from midstream.identity.passwords import (
    hash_password,
    needs_rehash,
    password_problem,
    verify_password,
)
from midstream.identity.permissions import (
    ADMIN_GROUP_ID,
    ALL_PERMISSIONS,
    BUILT_IN_GROUPS,
    BUILT_IN_ROLES,
    DATASET_PERMISSION_KEYS,
    PERMISSIONS,
    PERMISSION_KEYS,
    PERMISSION_SCOPES,
    SERVICE_PERMISSIONS,
    dataset_grantable,
    expand_permissions,
)
from midstream.identity.principals import clear_grants_cache, grants_for_groups
from midstream.identity.secrets import (
    BootstrapAdmin,
    IdentitySecrets,
    identity_secrets_from_environment,
    signing_key,
)
from midstream.identity.tokens import InvalidToken, SessionClaims, issue_token, peek_claims, read_token
from midstream.models.identity import (
    AccessToken,
    AuditEntry,
    ClaimRelease,
    Dataset,
    DatasetGrant,
    DirectoryState,
    Group,
    IdentityRequest,
    IdentityRequestOutcome,
    Invitation,
    PasswordCredential,
    RequestContext,
    Role,
    Session,
    SignInGuard,
    TableClaim,
    TokenRevocation,
    User,
    UserActivity,
    IDENTITY_ACTIONS,
)
from midstream.services.identity import (
    IdentityRejection,
    _HANDLERS,
    apply_identity_request,
    preview_identity_request,
)
from midstream.storage.identity import (
    find_user_by_email,
    get_directory_state,
    get_group,
    get_request_outcome,
    get_role,
    get_session,
    get_sign_in_guard,
    get_user,
    get_user_activity,
    iter_audit_entries,
    iter_groups,
    iter_roles,
    save_session,
    save_sign_in_guard,
    save_user,
    save_user_email,
)
from midstream.web.errors import WebError

import asyncio
import json
from unittest.mock import patch

from midstream.identity.tokens import peek_claims as _peek
from midstream.storage.identity import append_audit_entry, save_request_outcome
from midstream.web import auth, identity as views

NOW = "2026-10-13T12:00:00Z"
NOW_EPOCH = int(datetime(2026, 10, 13, 12, tzinfo=UTC).timestamp())
KEY = "k" * 40
SECRETS = IdentitySecrets(
    signing_keys=(signing_key(KEY),),
    service_token="s" * 40,
    bootstrap_admin=BootstrapAdmin(email="root@example.com", password="bootstrap-password-1", first_name="Root", last_name="Admin"),
    federation_keys=(signing_key("f" * 40),),
)
CONFIG = ControlPlaneConfig()
# Hashing is deliberately slow; tests that do not check the hash share one.
HASH = hash_password("correct horse battery staple")


class FakeTable:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, Any]] = {}

    def get(self, key: str) -> dict[str, Any] | None:
        return self.data.get(key)

    def __setitem__(self, key: str, value: dict[str, Any]) -> None:
        self.data[key] = value

    def __delitem__(self, key: str) -> None:
        del self.data[key]

    def prefix_scan(self, prefix: str) -> Iterable[tuple[str, dict[str, Any]]]:
        for key in sorted(self.data):
            if key.startswith(prefix):
                yield key, self.data[key]


def make_user(user_id: str, email: str, *, groups: list[str] | None = None, status: str = "active", must_change: bool = False) -> User:
    return User(
        user_id=user_id,
        email=email,
        first_name=user_id.title(),
        last_name="Person",
        status=status,
        group_ids=groups or [],
        password=PasswordCredential(hash=HASH, set_at=NOW, set_by="system", must_change=must_change),
        created_at=NOW,
        created_by="system",
        updated_at=NOW,
        updated_by="system",
    )


def store_user(table: FakeTable, user: User) -> User:
    save_user(table, user)
    save_user_email(table, user.email, user.user_id, updated_at=NOW)
    return user


def make_invited(user_id: str, email: str, *, groups: list[str] | None = None, link_hash: str | None = None, link_expires_at: str | None = None) -> User:
    """An invitation nobody named, as `invite_users` makes one."""
    return User(
        user_id=user_id,
        email=email,
        first_name="",
        last_name="",
        status="invited",
        group_ids=groups or [],
        invitation=Invitation(invited_at=NOW, invited_by="admin@example.com", link_hash=link_hash, link_expires_at=link_expires_at),
        created_at=NOW,
        created_by="admin@example.com",
        updated_at=NOW,
        updated_by="admin@example.com",
    )


def request(action: str, actor: str, payload: dict[str, Any] | None = None, *, request_id: str | None = None, base_revision: int | None = None) -> IdentityRequest:
    return IdentityRequest(
        request_id=request_id or f"idr-{action}-{actor}-{len(str(payload))}",
        action=action,
        submitted_at=NOW,
        actor_id=actor,
        actor_email=f"{actor}@example.com",
        payload=payload or {},
        base_revision=base_revision,
        context=RequestContext(ip="10.0.0.1", user_agent="test"),
    )


def apply(table: FakeTable, audit: FakeTable, action: str, actor: str, payload: dict[str, Any] | None = None, **kwargs: Any) -> IdentityRequestOutcome | None:
    return apply_identity_request(table, audit, request(action, actor, payload, **kwargs), config=CONFIG, secrets=SECRETS, applied_at=NOW)


def directory() -> tuple[FakeTable, FakeTable]:
    """A directory with an administrator, a user manager who is also an editor, and a viewer."""
    table, audit = FakeTable(), FakeTable()
    store_user(table, make_user("admin", "admin@example.com", groups=[ADMIN_GROUP_ID]))
    store_user(table, make_user("viewer", "viewer@example.com", groups=["viewer"]))
    managers = Group(
        group_id="grp-managers",
        name="User managers",
        role_ids=["user-manager"],
        created_at=NOW,
        created_by="system",
        updated_at=NOW,
        updated_by="system",
    )
    from midstream.storage.identity import save_group

    save_group(table, managers)
    store_user(table, make_user("manager", "manager@example.com", groups=["grp-managers", "editor"]))
    # As Data Reader once was, reading is the Viewer and Editor groups' - on this dataset.
    store_dataset(
        table,
        SHOP,
        grants={"admin": ("user", "dataset-owner"), "viewer": ("group", "dataset-reader"), "editor": ("group", "dataset-reader")},
    )
    return table, audit


#: The dataset `directory()` holds: the administrator owns it, and the Viewer and Editor groups read it.
SHOP = "ds-000000000001"


def store_dataset(table: FakeTable, dataset_id: str, *, name: str = "shop", grants: dict[str, tuple[str, str]] | None = None) -> None:
    """A dataset and its grants, by principal id: (user or group, role id)."""
    from midstream.models.identity import Dataset, DatasetGrant
    from midstream.storage.identity import save_dataset, save_dataset_grant, save_dataset_name

    save_dataset(table, Dataset(dataset_id=dataset_id, name=name, created_at=NOW, created_by="system", updated_at=NOW, updated_by="system"))
    save_dataset_name(table, name, dataset_id, updated_at=NOW)
    for principal_id, (principal_type, role_id) in (grants or {}).items():
        save_dataset_grant(
            table,
            DatasetGrant(
                dataset_id=dataset_id,
                principal_type=principal_type,
                principal_id=principal_id,
                role_ids=[role_id],
                updated_at=NOW,
                updated_by="system",
            ),
        )


class PermissionCatalogTests(unittest.TestCase):
    def test_keys_are_unique_and_implications_are_known(self) -> None:
        keys = [definition.key for definition in PERMISSIONS]
        self.assertEqual(len(keys), len(set(keys)))
        for definition in PERMISSIONS:
            for implied in definition.implies:
                self.assertIn(implied, PERMISSION_KEYS, f"{definition.key} implies unknown {implied}")
            self.assertTrue(definition.label and definition.description, definition.key)

    def test_built_in_roles_and_groups_refer_to_what_exists(self) -> None:
        role_ids = {role.role_id for role in BUILT_IN_ROLES}
        for role in BUILT_IN_ROLES:
            for permission in role.permissions:
                self.assertTrue(permission == ALL_PERMISSIONS or permission in PERMISSION_KEYS, permission)
        for group in BUILT_IN_GROUPS:
            for role_id in group.role_ids:
                self.assertIn(role_id, role_ids)
            for role_id in group.locked_role_ids:
                self.assertIn(role_id, group.role_ids)
        self.assertEqual(
            [group.group_id for group in BUILT_IN_GROUPS],
            ["guest", "all-users", "viewer", "editor", "admin"],
        )

    def test_implications_close_over_chains(self) -> None:
        self.assertEqual(expand_permissions(["data.export"]), {"data.export", "data.query", "dataset.view_schema"})
        self.assertEqual(expand_permissions(["catalog.write"]), {"catalog.write", "catalog.read", "dataset.view_schema"})
        self.assertEqual(expand_permissions(["datasets.create"]), {"datasets.create", "datasets.view"})
        self.assertEqual(expand_permissions([ALL_PERMISSIONS]), PERMISSION_KEYS)
        self.assertEqual(expand_permissions(["unknown.permission"]), frozenset())

    def test_a_permission_implies_only_permissions_of_its_own_scope(self) -> None:
        """A grant on one dataset never reaches beyond it: nothing a dataset permission implies is
        about the deployment."""
        by_key = {definition.key: definition for definition in PERMISSIONS}
        for definition in PERMISSIONS:
            self.assertIn(definition.scope, PERMISSION_SCOPES, definition.key)
            for implied in definition.implies:
                self.assertEqual(definition.scope, by_key[implied].scope, f"{definition.key} implies {implied}")
        self.assertEqual(
            {
                "dataset.view_schema",
                "data.query",
                "data.export",
                "catalog.read",
                "catalog.write",
                "dataset.write",
                "dataset.manage",
                "dataset.protect",
            },
            DATASET_PERMISSION_KEYS,
        )
        self.assertNotIn("materializations.view_schema", PERMISSION_KEYS)

    def test_only_roles_of_dataset_permissions_can_be_granted_on_a_dataset(self) -> None:
        roles = {role.role_id: role for role in BUILT_IN_ROLES}
        for role_id in ("dataset-reader", "dataset-writer", "dataset-owner"):
            self.assertTrue(dataset_grantable(roles[role_id].permissions), role_id)
        for role_id in ("administrator", "operator", "viewer", "status-viewer", "user-manager"):
            self.assertFalse(dataset_grantable(roles[role_id].permissions), role_id)
        self.assertFalse(dataset_grantable([]))
        reader, writer, owner = (expand_permissions(roles[role_id].permissions) for role_id in ("dataset-reader", "dataset-writer", "dataset-owner"))
        self.assertEqual({"dataset.view_schema", "data.query", "data.export", "catalog.read"}, reader)
        self.assertEqual(reader | {"dataset.write"}, writer)
        # The owner decides how materializations writing into the dataset mask sensitive data; a
        # writer does not (design D9).
        self.assertEqual(writer | {"dataset.manage", "dataset.protect"}, owner)
        # Committing from outside the runtime can rewrite its data: no built-in dataset role may.
        self.assertNotIn("catalog.write", owner)

    def test_the_service_credential_only_reads(self) -> None:
        self.assertTrue(all(key.endswith(".view") or key.endswith(".view_details") or key.endswith(".view_schema") for key in SERVICE_PERMISSIONS))
        self.assertIn("settings.view", SERVICE_PERMISSIONS)
        self.assertIn("datasets.view", SERVICE_PERMISSIONS)
        # The console builds its live views from every schema, and filters them per person.
        self.assertIn("dataset.view_schema", SERVICE_PERMISSIONS)
        self.assertNotIn("settings.manage", SERVICE_PERMISSIONS)
        self.assertNotIn("data.query", SERVICE_PERMISSIONS)

    def test_default_groups_grant_what_was_agreed(self) -> None:
        table = FakeTable()
        guest = grants_for_groups(table, ["guest"])
        self.assertEqual(guest.permissions, {"materializations.view"})
        everyone = grants_for_groups(table, ["guest", "all-users"])
        self.assertEqual(everyone.permissions, {"materializations.view", "materializations.view_details", "datasets.view"})
        viewer = grants_for_groups(table, ["viewer"])
        # Reading a dataset needs a role on it: neither Viewer nor Editor reads every dataset.
        self.assertFalse(DATASET_PERMISSION_KEYS & viewer.permissions)
        self.assertNotIn("materializations.create", viewer.permissions)
        editor = grants_for_groups(table, ["editor"])
        self.assertTrue(
            {"materializations.create", "materializations.delete", "materializations.maintain", "topics.view", "datasets.create"}
            <= editor.permissions
        )
        self.assertFalse(DATASET_PERMISSION_KEYS & editor.permissions)
        self.assertNotIn("settings.view", editor.permissions)
        admin = grants_for_groups(table, ["admin"])
        self.assertTrue(admin.all_permissions)
        self.assertEqual(admin.permissions, PERMISSION_KEYS)
        # Only administrators change the data protection defaults: managing settings does not.
        holders = [
            role.role_id
            for role in BUILT_IN_ROLES
            if "settings.manage_protection" in expand_permissions(role.permissions)
        ]
        self.assertEqual(["administrator"], holders)
        self.assertNotIn("settings.manage_protection", expand_permissions(["settings.manage"]))


class PasswordTests(unittest.TestCase):
    def test_hash_verifies_only_the_password_it_was_made_from(self) -> None:
        self.assertTrue(HASH.startswith("$scrypt$ln=15,r=8,p=3$"))
        self.assertTrue(verify_password("correct horse battery staple", HASH))
        self.assertFalse(verify_password("correct horse battery stapl", HASH))
        self.assertFalse(verify_password("anything", None))
        self.assertFalse(verify_password("anything", "not a hash"))
        self.assertFalse(needs_rehash(HASH))
        self.assertTrue(needs_rehash("$scrypt$ln=14,r=8,p=1$c2FsdA$aGFzaA"))

    def test_each_hash_is_salted(self) -> None:
        self.assertNotEqual(hash_password("same password here"), hash_password("same password here"))

    def test_policy_is_about_length_and_personal_details(self) -> None:
        self.assertIsNone(password_problem("a long enough passphrase", min_length=12))
        self.assertRegex(password_problem("short", min_length=12) or "", "at least 12")
        self.assertRegex(password_problem("x" * 300, min_length=12) or "", "at most")
        self.assertRegex(password_problem("aaaaaaaaaaaaaa", min_length=12) or "", "repeat")
        self.assertRegex(
            password_problem("jane.doe@example.com", min_length=12, email="jane.doe@example.com") or "",
            "email or name",
        )
        self.assertRegex(
            password_problem("Jane Doe-Smith", min_length=8, first_name="Jane", last_name="Doe-Smith") or "",
            "email or name",
        )
        self.assertRegex(password_problem(None, min_length=12) or "", "text")


class TokenTests(unittest.TestCase):
    def claims(self, **changes: Any) -> SessionClaims:
        base = SessionClaims(
            session_id="ses-1",
            user_id="usr-1",
            session_epoch=2,
            issued_at=NOW_EPOCH,
            expires_at=NOW_EPOCH + 3600,
            session_expires_at=NOW_EPOCH + 86400,
            signed_in_at=NOW_EPOCH,
        )
        return replace(base, **changes)

    def test_round_trip(self) -> None:
        token = issue_token(self.claims(), SECRETS)
        self.assertEqual(read_token(token, SECRETS, now=NOW_EPOCH + 10), self.claims())
        self.assertEqual(peek_claims(token), self.claims())

    def test_refuses_tampering_other_keys_and_expiry(self) -> None:
        token = issue_token(self.claims(), SECRETS)
        version, payload, signature = token.split(".")
        forged = issue_token(self.claims(user_id="usr-admin"), SECRETS).split(".")[1]
        for candidate, reason in (
            (f"{version}.{forged}.{signature}", "signature"),
            (f"{version}.{payload}.{signature[:-2]}AA", "signature"),
            ("v2." + payload + "." + signature, "malformed"),
            ("garbage", "malformed"),
        ):
            with self.subTest(reason=reason), self.assertRaises(InvalidToken) as caught:
                read_token(candidate, SECRETS, now=NOW_EPOCH)
            self.assertEqual(caught.exception.reason, reason)
        other = IdentitySecrets(signing_keys=(signing_key("o" * 40),))
        with self.assertRaises(InvalidToken):
            read_token(token, other, now=NOW_EPOCH)
        with self.assertRaises(InvalidToken) as expired:
            read_token(token, SECRETS, now=NOW_EPOCH + 3601)
        self.assertEqual(expired.exception.reason, "expired")
        absolute = issue_token(self.claims(expires_at=NOW_EPOCH + 999_999), SECRETS)
        with self.assertRaises(InvalidToken):
            read_token(absolute, SECRETS, now=NOW_EPOCH + 86401)

    def test_previous_key_still_verifies_after_rotation(self) -> None:
        token = issue_token(self.claims(), SECRETS)
        rotated = IdentitySecrets(signing_keys=(signing_key("n" * 40), signing_key(KEY)))
        self.assertEqual(read_token(token, rotated, now=NOW_EPOCH).user_id, "usr-1")

    def test_secrets_from_environment(self) -> None:
        secrets = identity_secrets_from_environment(
            {
                "AUTH_SIGNING_KEY": KEY,
                "AUTH_PREVIOUS_SIGNING_KEY": "p" * 40,
                "AUTH_SERVICE_TOKEN": "short",
                "AUTH_BOOTSTRAP_ADMIN_EMAIL": " Root@Example.com ",
                "AUTH_BOOTSTRAP_ADMIN_PASSWORD": "pw",
            }
        )
        self.assertEqual(len(secrets.signing_keys), 2)
        self.assertIsNone(secrets.service_token, "a short service token is ignored")
        self.assertEqual(secrets.bootstrap_admin.email, "root@example.com")
        self.assertEqual(secrets.bootstrap_admin.first_name, "Admin")
        lone_previous = identity_secrets_from_environment({"AUTH_PREVIOUS_SIGNING_KEY": "p" * 40})
        self.assertFalse(lone_previous.can_sign_in)
        weak = identity_secrets_from_environment({"AUTH_SIGNING_KEY": "too-short"})
        self.assertFalse(weak.can_sign_in)

    def test_federation_keys_rotate_like_signing_keys(self) -> None:
        secrets = identity_secrets_from_environment(
            {"AUTH_FEDERATION_KEY": "f" * 40, "AUTH_PREVIOUS_FEDERATION_KEY": "g" * 40}
        )
        self.assertEqual(len(secrets.federation_keys), 2)
        self.assertEqual(secrets.current_federation_key, signing_key("f" * 40))
        self.assertEqual(secrets.federation_key(signing_key("g" * 40).key_id), signing_key("g" * 40))
        self.assertIsNone(identity_secrets_from_environment({"AUTH_PREVIOUS_FEDERATION_KEY": "g" * 40}).current_federation_key)
        self.assertIsNone(identity_secrets_from_environment({"AUTH_FEDERATION_KEY": "short"}).current_federation_key)


class ModelRoundTripTests(unittest.TestCase):
    def test_every_model_round_trips(self) -> None:
        user = make_user("usr-1", "a@example.com", groups=["editor"], must_change=True)
        samples = [
            user,
            Group(group_id="grp-1", name="Ops", role_ids=["operator"], created_at=NOW, created_by="a", updated_at=NOW, updated_by="a"),
            Role(role_id="rol-1", name="Readers", permissions=["data.query"], created_at=NOW, created_by="a", updated_at=NOW, updated_by="a"),
            Session(session_id="ses-1", user_id="usr-1", created_at=NOW, expires_at=NOW, last_seen_at=NOW, ip="1.2.3.4"),
            SignInGuard(email="a@example.com", failed_attempts=3, locked_until=NOW),
            UserActivity(user_id="usr-1", last_sign_in_at=NOW, sign_in_count=4),
            IdentityRequest(request_id="idr-1", action="create_user", submitted_at=NOW, actor_id="usr-1", payload={"x": 1}, base_revision=3),
            IdentityRequestOutcome(request_id="idr-1", action="create_user", status="rejected", completed_at=NOW, actor_id="usr-1", reason="invalid", field="email"),
            IdentityRequestOutcome(
                request_id="idr-2",
                action="claim_tables",
                status="rejected",
                completed_at=NOW,
                actor_id="usr-1",
                reason="table_name_taken",
                field="tables.0.name",
                details={"index": 0, "dataset": "sales", "table": "orders", "source_topic": "sales.orders"},
            ),
            DirectoryState(revision=4, updated_at=NOW, seeded_at=NOW),
            AuditEntry(entry_id="aud-1", occurred_at=NOW, action="user.created", details={"email": "a@example.com"}),
            AccessToken(
                token_id="0123456789ab",
                user_id="usr-1",
                name="duckdb",
                permissions=("catalog.read",),
                created_at=NOW,
                expires_at=NOW,
                issuer="domain_a",
                datasets=("domain_a.sales", "domain_b.finance"),
            ),
            TokenRevocation(token_id="0123456789ab", expires_at=NOW_EPOCH, signature="abcd1234.sig", revoked_at=NOW, source="domain_b"),
            Dataset(dataset_id="ds-000000000001", name="sales", description="Orders and refunds", revision=2, created_at=NOW, created_by="usr-1", updated_at=NOW, updated_by="usr-1"),
            DatasetGrant(dataset_id="ds-000000000001", principal_type="group", principal_id="all-users", role_ids=["dataset-reader"], updated_at=NOW, updated_by="usr-1"),
            TableClaim(
                dataset_id="ds-000000000001",
                table="orders",
                materialization_id="mat-a1b2c3d4e5f6",
                source_topic="sales.orders",
                claimed_at=NOW,
                claimed_by="usr-1",
                request_id="idr-claim-req-1",
            ),
            ClaimRelease(materialization_id="mat-a1b2c3d4e5f6", released_at=NOW),
        ]
        for sample in samples:
            with self.subTest(model=type(sample).__name__):
                self.assertEqual(type(sample).from_dict(sample.to_dict()), sample)
        self.assertEqual(user.sign_in_methods(), ["password"])
        self.assertTrue(user.must_change_password)

    def test_validation(self) -> None:
        with self.assertRaises(ValueError):
            IdentityRequest(request_id="idr-1", action="drop_tables", submitted_at=NOW, actor_id="x")
        with self.assertRaises(ValueError):
            replace(make_user("u", "u@example.com"), status="banned")
        with self.assertRaisesRegex(ValueError, "principal_type"):
            DatasetGrant(dataset_id="ds-1", principal_type="role", principal_id="x", role_ids=[], updated_at=NOW, updated_by="a")
        with self.assertRaisesRegex(ValueError, "revision"):
            Dataset(dataset_id="ds-1", name="sales", created_at=NOW, created_by="a", updated_at=NOW, updated_by="a", revision=0)
        with self.assertRaises(ValueError):
            TableClaim(dataset_id="ds-1", table="", materialization_id="mat-1", source_topic="t", claimed_at=NOW, claimed_by="a", request_id="r")

    def test_records_written_before_datasets_read_as_unlimited_and_without_details(self) -> None:
        token = AccessToken(token_id="0123456789ab", user_id="usr-1", name="t", permissions=("catalog.read",), created_at=NOW, expires_at=NOW)
        stored = token.to_dict()
        del stored["datasets"]
        self.assertEqual((), AccessToken.from_dict(stored).datasets)
        outcome = IdentityRequestOutcome(request_id="idr-1", action="create_user", status="applied", completed_at=NOW, actor_id="usr-1").to_dict()
        del outcome["details"]
        self.assertEqual({}, IdentityRequestOutcome.from_dict(outcome).details)

    def test_every_action_has_a_handler(self) -> None:
        self.assertEqual(set(_HANDLERS), set(IDENTITY_ACTIONS))


class StorageTests(unittest.TestCase):
    def test_built_in_groups_and_roles_exist_before_anything_is_stored(self) -> None:
        table = FakeTable()
        self.assertEqual([group.group_id for group in iter_groups(table)], ["guest", "all-users", "viewer", "editor", "admin"])
        self.assertEqual(get_group(table, "admin").role_ids, ["administrator"])
        self.assertTrue(get_role(table, "administrator").built_in)
        self.assertIsNone(get_group(table, "grp-missing"))
        self.assertEqual(len(iter_roles(table)), len(BUILT_IN_ROLES))

    def test_email_lookup_ignores_case_and_follows_changes(self) -> None:
        table = FakeTable()
        store_user(table, make_user("usr-1", "jane@example.com"))
        self.assertEqual(find_user_by_email(table, " JANE@example.com ").user_id, "usr-1")
        self.assertIsNone(find_user_by_email(table, "john@example.com"))

    def test_audit_reads_day_by_day_newest_first_with_a_cursor(self) -> None:
        table = FakeTable()
        from midstream.storage.identity import append_audit_entry

        for index, moment in enumerate(("2026-10-11T09:00:00Z", "2026-10-12T09:00:00Z", "2026-10-13T08:00:00Z", "2026-10-13T09:00:00Z")):
            append_audit_entry(table, AuditEntry(entry_id=f"aud-{index}", occurred_at=moment, action="user.created"))
        entries = list(iter_audit_entries(table, newest=NOW, oldest="2026-10-01"))
        self.assertEqual([entry.entry_id for _, entry in entries], ["aud-3", "aud-2", "aud-1", "aud-0"])
        cursor = entries[1][0]
        rest = list(iter_audit_entries(table, newest=NOW, oldest="2026-10-01", before=cursor))
        self.assertEqual([entry.entry_id for _, entry in rest], ["aud-1", "aud-0"])
        recent = list(iter_audit_entries(table, newest=NOW, oldest="2026-10-12"))
        self.assertEqual(len(recent), 3)


def http_request(token: str | None = None, **headers: str) -> SimpleNamespace:
    values = dict(headers)
    if token is not None:
        values["Authorization"] = f"Bearer {token}"
    return SimpleNamespace(headers=values, remote="10.1.1.1")


def session_token(user: User, *, session_id: str = "ses-1", epoch: int | None = None, expires: int = 3600) -> str:
    return issue_token(
        SessionClaims(
            session_id=session_id,
            user_id=user.user_id,
            session_epoch=user.session_epoch if epoch is None else epoch,
            issued_at=NOW_EPOCH,
            expires_at=NOW_EPOCH + expires,
            session_expires_at=NOW_EPOCH + 86400,
            signed_in_at=NOW_EPOCH,
        ),
        SECRETS,
    )


class AuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_grants_cache()
        self.table, _ = directory()
        self.viewer = get_user(self.table, "viewer")

    def authorize(self, request: Any, permission: str | None, **kwargs: Any):
        return authorize(request, self.table, permission, secrets=SECRETS, now=NOW_EPOCH, **kwargs)

    def test_a_request_without_a_session_is_a_guest(self) -> None:
        principal = self.authorize(http_request(), "materializations.view")
        self.assertEqual(principal.kind, "guest")
        with self.assertRaises(WebError) as caught:
            self.authorize(http_request(), "materializations.view_details")
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(caught.exception.details["reason"], "sign_in_required")

    def test_a_signed_in_person_holds_their_groups_and_more_than_a_guest(self) -> None:
        principal = self.authorize(http_request(session_token(self.viewer)), "materializations.view_details")
        self.assertEqual(principal.kind, "user")
        self.assertEqual(principal.email, "viewer@example.com")
        self.assertTrue(principal.can("materializations.view"))
        self.assertEqual(principal.grants.group_ids, ("guest", "all-users", "viewer"))
        with self.assertRaises(WebError) as caught:
            self.authorize(http_request(session_token(self.viewer)), "materializations.delete")
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.details["permission"], "materializations.delete")

    def test_the_service_token_reads_but_never_changes(self) -> None:
        principal = self.authorize(http_request("s" * 40), "settings.view")
        self.assertEqual(principal.kind, "service")
        with self.assertRaises(WebError):
            self.authorize(http_request("s" * 40), "settings.manage")

    def test_unusable_sessions_are_refused_not_downgraded(self) -> None:
        cases = {
            "session_expired": session_token(self.viewer, expires=-10),
            "invalid_session": "v1.not.valid",
        }
        for reason, token in cases.items():
            with self.subTest(reason=reason), self.assertRaises(WebError) as caught:
                self.authorize(http_request(token), "materializations.view")
            self.assertEqual(caught.exception.status_code, 401)
            self.assertEqual(caught.exception.details["reason"], reason)

    def test_deactivation_and_ending_sessions_take_effect_at_the_next_request(self) -> None:
        token = session_token(self.viewer)
        save_user(self.table, replace(self.viewer, session_epoch=1))
        with self.assertRaises(WebError) as ended:
            self.authorize(http_request(token), None)
        self.assertEqual(ended.exception.details["reason"], "session_ended")
        save_user(self.table, replace(self.viewer, status="deactivated"))
        with self.assertRaises(WebError) as deactivated:
            self.authorize(http_request(token), None)
        self.assertEqual(deactivated.exception.details["reason"], "account_deactivated")

    def test_one_ended_session_does_not_end_the_others(self) -> None:
        save_session(
            self.table,
            Session(session_id="ses-1", user_id="viewer", created_at=NOW, expires_at=NOW, last_seen_at=NOW, ended_at=NOW),
            updated_at=NOW,
        )
        with self.assertRaises(WebError):
            self.authorize(http_request(session_token(self.viewer, session_id="ses-1")), None)
        self.assertEqual(self.authorize(http_request(session_token(self.viewer, session_id="ses-2")), None).kind, "user")

    def test_a_password_someone_else_chose_must_be_replaced_first(self) -> None:
        save_user(self.table, replace(self.viewer, password=replace(self.viewer.password, must_change=True)))
        token = session_token(self.viewer)
        with self.assertRaises(WebError) as caught:
            self.authorize(http_request(token), "materializations.view")
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(caught.exception.details["reason"], "password_change_required")
        self.assertTrue(self.authorize(http_request(token), None, allow_password_change=True).password_change_required)

    def test_header_parsing(self) -> None:
        self.assertEqual(bearer_token(http_request(authorization="bearer abc")), "abc")
        self.assertIsNone(bearer_token(http_request(authorization="Basic abc")))
        context = request_context(http_request(**{"X-Forwarded-For": "203.0.113.9, 10.0.0.1", "User-Agent": "curl"}))
        self.assertEqual((context.ip, context.user_agent), ("203.0.113.9", "curl"))

    def test_a_directory_change_applies_to_the_next_request(self) -> None:
        token = session_token(self.viewer)
        self.assertFalse(self.authorize(http_request(token), None).can("materializations.create"))
        save_user(self.table, replace(self.viewer, group_ids=["editor"]))
        from midstream.storage.identity import save_directory_state

        save_directory_state(self.table, DirectoryState(revision=get_directory_state(self.table).revision + 1, updated_at=NOW))
        self.assertTrue(self.authorize(http_request(token), None).can("materializations.create"))

    def test_without_a_signing_key_sessions_cannot_be_used(self) -> None:
        with self.assertRaises(WebError) as caught:
            authenticate(http_request("v1.a.b"), self.table, secrets=IdentitySecrets(), now=NOW_EPOCH)
        self.assertEqual(caught.exception.details["reason"], "sign_in_unavailable")


class BootstrapTests(unittest.TestCase):
    def test_seeds_built_in_groups_and_the_first_administrator_once(self) -> None:
        table, audit = FakeTable(), FakeTable()
        apply(table, audit, "bootstrap", "system")
        admin = find_user_by_email(table, "root@example.com")
        self.assertIsNotNone(admin)
        self.assertEqual(admin.group_ids, [ADMIN_GROUP_ID])
        self.assertTrue(admin.must_change_password)
        self.assertTrue(verify_password("bootstrap-password-1", admin.password.hash))
        self.assertIn("group:admin", table.data)
        self.assertIsNotNone(get_directory_state(table).seeded_at)
        revision = get_directory_state(table).revision
        apply(table, audit, "bootstrap", "system", request_id="idr-bootstrap-again")
        self.assertEqual(find_user_by_email(table, "root@example.com").revision, admin.revision)
        self.assertEqual(get_directory_state(table).revision, revision)

    def test_restores_the_bootstrap_administrator_when_none_is_active(self) -> None:
        table, audit = FakeTable(), FakeTable()
        store_user(table, make_user("root", "root@example.com", status="deactivated"))
        apply(table, audit, "bootstrap", "system")
        root = get_user(table, "root")
        self.assertEqual(root.status, "active")
        self.assertIn(ADMIN_GROUP_ID, root.group_ids)
        self.assertEqual(root.session_epoch, 1)


class DirectoryRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.table, self.audit = directory()

    def outcome(self, action: str, actor: str, payload: dict[str, Any], **kwargs: Any) -> IdentityRequestOutcome:
        result = apply(self.table, self.audit, action, actor, payload, **kwargs)
        assert result is not None
        return result

    def assertRefused(self, outcome: IdentityRequestOutcome, reason: str) -> None:
        self.assertEqual(outcome.status, "rejected", outcome.message)
        self.assertEqual(outcome.reason, reason, outcome.message)

    def test_create_user_starts_with_a_password_to_replace(self) -> None:
        result = self.outcome(
            "create_user",
            "admin",
            {"user_id": "usr-new", "email": "New@Example.com", "first_name": " Ada ", "last_name": "Lovelace", "group_ids": ["viewer"], "password_hash": HASH},
        )
        self.assertEqual(result.status, "applied", result.message)
        user = get_user(self.table, "usr-new")
        self.assertEqual((user.email, user.first_name, user.group_ids), ("new@example.com", "Ada", ["viewer"]))
        self.assertTrue(user.must_change_password)
        self.assertEqual(user.created_by, "admin@example.com")
        self.assertEqual(get_request_outcome(self.table, result.request_id).status, "applied")
        actions = [entry.action for _, entry in iter_audit_entries(self.audit, newest=NOW, oldest="2026-10-01")]
        self.assertIn("user.created", actions)

    def test_one_account_per_email(self) -> None:
        result = self.outcome(
            "create_user",
            "admin",
            {"user_id": "usr-dupe", "email": "VIEWER@example.com", "first_name": "A", "last_name": "B", "password_hash": HASH},
        )
        self.assertRefused(result, "already_exists")
        self.assertEqual(result.field, "email")

    def test_nobody_is_added_to_automatic_groups(self) -> None:
        result = self.outcome(
            "create_user",
            "admin",
            {"user_id": "usr-x", "email": "x@example.com", "first_name": "A", "last_name": "B", "group_ids": ["all-users"], "password_hash": HASH},
        )
        self.assertRefused(result, "invalid")

    def test_a_redelivered_request_applies_once(self) -> None:
        payload = {"user_id": "usr-r", "email": "r@example.com", "first_name": "R", "last_name": "R", "password_hash": HASH}
        first = self.outcome("create_user", "admin", payload, request_id="idr-same")
        revision = get_directory_state(self.table).revision
        second = self.outcome("create_user", "admin", payload, request_id="idr-same")
        self.assertEqual(first, second)
        self.assertEqual(get_directory_state(self.table).revision, revision)

    def test_access_cannot_be_granted_by_someone_who_lacks_it(self) -> None:
        # The manager holds user management and Editor's access, but not Admin's.
        to_admin = self.outcome(
            "create_user",
            "manager",
            {"user_id": "usr-y", "email": "y@example.com", "first_name": "A", "last_name": "B", "group_ids": [ADMIN_GROUP_ID], "password_hash": HASH},
        )
        self.assertRefused(to_admin, "forbidden")
        to_editor = self.outcome(
            "create_user",
            "manager",
            {"user_id": "usr-z", "email": "z@example.com", "first_name": "A", "last_name": "B", "group_ids": ["editor"], "password_hash": HASH},
        )
        self.assertEqual(to_editor.status, "applied", to_editor.message)
        reset_admin = self.outcome("set_user_password", "manager", {"user_id": "admin", "password_hash": HASH})
        self.assertRefused(reset_admin, "forbidden")
        promote_self = self.outcome("update_user", "manager", {"user_id": "manager", "group_ids": ["grp-managers", "editor", ADMIN_GROUP_ID]})
        self.assertRefused(promote_self, "forbidden")
        role = self.outcome("create_role", "manager", {"role_id": "rol-x", "name": "Sneaky", "permissions": ["settings.manage"]})
        self.assertRefused(role, "forbidden")

    def test_a_viewer_cannot_manage_anyone(self) -> None:
        result = self.outcome("update_user", "viewer", {"user_id": "viewer", "first_name": "Me"})
        self.assertRefused(result, "forbidden")

    def test_there_is_always_an_active_administrator(self) -> None:
        demote = self.outcome("update_user", "admin", {"user_id": "admin", "group_ids": []})
        self.assertRefused(demote, "last_administrator")
        self_deactivate = self.outcome("update_user", "admin", {"user_id": "admin", "status": "deactivated"})
        self.assertRefused(self_deactivate, "self_action")
        unlock_role = self.outcome("update_group", "admin", {"group_id": ADMIN_GROUP_ID, "role_ids": []})
        self.assertRefused(unlock_role, "locked_role")
        store_user(self.table, make_user("admin2", "admin2@example.com", groups=[ADMIN_GROUP_ID]))
        demoted = self.outcome("update_user", "admin2", {"user_id": "admin", "group_ids": []})
        self.assertEqual(demoted.status, "applied", demoted.message)
        last = self.outcome("update_group", "admin2", {"group_id": ADMIN_GROUP_ID, "remove_member_ids": ["admin2"]})
        self.assertRefused(last, "last_administrator")

    def test_deactivating_ends_every_session(self) -> None:
        save_session(
            self.table,
            Session(session_id="ses-v", user_id="viewer", created_at=NOW, expires_at="2026-10-20T00:00:00Z", last_seen_at=NOW),
            updated_at=NOW,
        )
        result = self.outcome("update_user", "admin", {"user_id": "viewer", "status": "deactivated"})
        self.assertEqual(result.status, "applied", result.message)
        viewer = get_user(self.table, "viewer")
        self.assertEqual((viewer.status, viewer.session_epoch), ("deactivated", 1))
        self.assertEqual(get_session(self.table, "viewer", "ses-v").ended_reason, "deactivated")
        reactivated = self.outcome("update_user", "admin", {"user_id": "viewer", "status": "active"})
        self.assertEqual(reactivated.status, "applied")
        self.assertIsNone(get_user(self.table, "viewer").deactivated_at)

    def test_email_change_moves_the_index(self) -> None:
        result = self.outcome("update_user", "admin", {"user_id": "viewer", "email": "renamed@example.com"})
        self.assertEqual(result.status, "applied", result.message)
        self.assertIsNone(find_user_by_email(self.table, "viewer@example.com"))
        self.assertEqual(find_user_by_email(self.table, "renamed@example.com").user_id, "viewer")

    def test_stale_edits_are_refused(self) -> None:
        result = self.outcome("update_user", "admin", {"user_id": "viewer", "first_name": "X"}, base_revision=7)
        self.assertRefused(result, "changed")

    def test_password_reset_and_change(self) -> None:
        reset = self.outcome("set_user_password", "admin", {"user_id": "viewer", "password_hash": HASH})
        self.assertEqual(reset.status, "applied", reset.message)
        viewer = get_user(self.table, "viewer")
        self.assertTrue(viewer.must_change_password)
        self.assertEqual(viewer.session_epoch, 1)
        changed = self.outcome("change_password", "viewer", {"user_id": "viewer", "password_hash": HASH})
        self.assertEqual(changed.status, "applied", changed.message)
        viewer = get_user(self.table, "viewer")
        self.assertFalse(viewer.must_change_password)
        self.assertEqual(viewer.session_epoch, 2)
        other = self.outcome("change_password", "viewer", {"user_id": "admin", "password_hash": HASH})
        self.assertRefused(other, "forbidden")
        self_reset = self.outcome("set_user_password", "admin", {"user_id": "admin", "password_hash": HASH})
        self.assertRefused(self_reset, "self_action")

    def test_delete_needs_deactivation_first_and_frees_the_email(self) -> None:
        self.assertRefused(self.outcome("delete_user", "admin", {"user_id": "viewer"}), "invalid")
        self.outcome("update_user", "admin", {"user_id": "viewer", "status": "deactivated"})
        deleted = self.outcome("delete_user", "admin", {"user_id": "viewer"}, request_id="idr-delete")
        self.assertEqual(deleted.status, "applied", deleted.message)
        self.assertIsNone(get_user(self.table, "viewer"))
        self.assertIsNone(find_user_by_email(self.table, "viewer@example.com"))

    def test_groups(self) -> None:
        created = self.outcome(
            "create_group",
            "admin",
            {"group_id": "grp-ops", "name": "Ops", "description": "On call", "role_ids": ["operator"], "member_ids": ["viewer"]},
        )
        self.assertEqual(created.status, "applied", created.message)
        self.assertIn("grp-ops", get_user(self.table, "viewer").group_ids)
        clash = self.outcome("create_group", "admin", {"group_id": "grp-other", "name": "ops"})
        self.assertRefused(clash, "already_exists")
        renamed = self.outcome("update_group", "admin", {"group_id": "grp-ops", "name": "Operations"}, base_revision=1)
        self.assertEqual(renamed.status, "applied", renamed.message)
        self.assertEqual(get_group(self.table, "grp-ops").revision, 2)
        builtin = self.outcome("update_group", "admin", {"group_id": "viewer", "name": "Readers"})
        self.assertRefused(builtin, "built_in")
        self.assertRefused(self.outcome("delete_group", "admin", {"group_id": "editor"}), "built_in")
        roles = self.outcome("update_group", "admin", {"group_id": "all-users", "role_ids": ["viewer", "dataset-reader"]})
        self.assertEqual(roles.status, "applied", roles.message)
        self.assertEqual(get_group(self.table, "all-users").role_ids, ["viewer", "dataset-reader"])
        automatic = self.outcome("update_group", "admin", {"group_id": "all-users", "add_member_ids": ["viewer"]})
        self.assertRefused(automatic, "invalid")
        deleted = self.outcome("delete_group", "admin", {"group_id": "grp-ops"})
        self.assertEqual(deleted.status, "applied", deleted.message)
        self.assertNotIn("grp-ops", get_user(self.table, "viewer").group_ids)

    def test_roles(self) -> None:
        created = self.outcome(
            "create_role",
            "admin",
            {"role_id": "rol-ex", "name": "Exporters", "permissions": ["data.export", "data.export"]},
        )
        self.assertEqual(created.status, "applied", created.message)
        self.assertEqual(get_role(self.table, "rol-ex").permissions, ["data.export"])
        everything = self.outcome("create_role", "admin", {"role_id": "rol-all", "name": "All", "permissions": ["*"]})
        self.assertRefused(everything, "invalid")
        unknown = self.outcome("create_role", "admin", {"role_id": "rol-u", "name": "U", "permissions": ["nope"]})
        self.assertRefused(unknown, "invalid")
        builtin = self.outcome("update_role", "admin", {"role_id": "viewer", "permissions": []})
        self.assertRefused(builtin, "built_in")
        self.outcome("create_group", "admin", {"group_id": "grp-ex", "name": "Exporters", "role_ids": ["rol-ex"]})
        updated = self.outcome("update_role", "admin", {"role_id": "rol-ex", "permissions": ["data.query"]})
        self.assertEqual(updated.status, "applied", updated.message)
        deleted = self.outcome("delete_role", "admin", {"role_id": "rol-ex"})
        self.assertEqual(deleted.status, "applied", deleted.message)
        self.assertEqual(get_group(self.table, "grp-ex").role_ids, [])

    def test_every_directory_change_raises_the_revision(self) -> None:
        before = get_directory_state(self.table).revision
        self.outcome("update_user", "admin", {"user_id": "viewer", "first_name": "Vee"})
        self.assertEqual(get_directory_state(self.table).revision, before + 1)
        self.outcome("unlock_user", "admin", {"user_id": "viewer"})
        self.assertEqual(get_directory_state(self.table).revision, before + 1, "unlocking changes no access")

    def test_preview_refuses_what_the_agent_would_and_writes_nothing(self) -> None:
        snapshot = dict(self.table.data)
        with self.assertRaises(IdentityRejection) as caught:
            preview_identity_request(self.table, request("update_user", "admin", {"user_id": "admin", "group_ids": []}), config=CONFIG, secrets=SECRETS)
        self.assertEqual(caught.exception.reason, "last_administrator")
        preview_identity_request(self.table, request("update_user", "admin", {"user_id": "viewer", "first_name": "Ok"}), config=CONFIG, secrets=SECRETS)
        self.assertEqual(self.table.data, snapshot)


class SessionEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.table, self.audit = directory()

    def test_sign_in_records_the_session_and_activity(self) -> None:
        save_sign_in_guard(self.table, SignInGuard(email="viewer@example.com", failed_attempts=3), updated_at=NOW)
        apply(
            self.table,
            self.audit,
            "sign_in_succeeded",
            "viewer",
            {"session_id": "ses-9", "user_id": "viewer", "method": "password", "created_at": NOW, "expires_at": "2026-10-20T12:00:00Z"},
        )
        session = get_session(self.table, "viewer", "ses-9")
        self.assertEqual((session.ip, session.user_agent), ("10.0.0.1", "test"))
        self.assertEqual(get_user_activity(self.table, "viewer").sign_in_count, 1)
        self.assertIsNone(get_sign_in_guard(self.table, "viewer@example.com"), "a success resets failures")
        apply(self.table, self.audit, "sign_out", "viewer", {"session_id": "ses-9", "scope": "current"})
        self.assertEqual(get_session(self.table, "viewer", "ses-9").ended_reason, "signed_out")
        signed_out = next(
            entry
            for _, entry in iter_audit_entries(self.audit, newest=NOW, oldest="2026-10-01")
            if entry.action == "session.signed_out"
        )
        self.assertEqual(signed_out.target_label, "Viewer Person <viewer@example.com>")

    def test_failures_lock_an_email_out_whether_or_not_it_has_an_account(self) -> None:
        config = replace(CONFIG, sign_in_max_failed_attempts=3, sign_in_lockout_minutes=15)
        for index in range(3):
            apply_identity_request(
                self.table,
                self.audit,
                request("sign_in_failed", "anonymous", {"email": "ghost@example.com", "reason": "unknown_email"}, request_id=f"idr-f{index}"),
                config=config,
                secrets=SECRETS,
                applied_at=NOW,
            )
        guard = get_sign_in_guard(self.table, "ghost@example.com")
        self.assertEqual(guard.failed_attempts, 3)
        self.assertEqual(guard.locked_until, "2026-10-13T12:15:00Z")
        entries = [entry for _, entry in iter_audit_entries(self.audit, newest=NOW, oldest="2026-10-01")]
        self.assertEqual(
            [(entry.action, entry.details["attempts"]) for entry in entries],
            [
                ("session.locked_out", 3),
                ("session.sign_in_failed", 3),
                ("session.sign_in_failed", 2),
                ("session.sign_in_failed", 1),
            ],
            "entries of one second list newest first, in the order they were recorded",
        )

    def test_signing_out_others_keeps_the_current_session(self) -> None:
        for session_id in ("ses-a", "ses-b", "ses-c"):
            save_session(
                self.table,
                Session(session_id=session_id, user_id="viewer", created_at=NOW, expires_at="2026-10-20T00:00:00Z", last_seen_at=NOW),
                updated_at=NOW,
            )
        apply(self.table, self.audit, "sign_out", "viewer", {"session_id": "ses-b", "scope": "others"})
        self.assertIsNone(get_session(self.table, "viewer", "ses-b").ended_at)
        self.assertIsNotNone(get_session(self.table, "viewer", "ses-a").ended_at)
        self.assertIsNotNone(get_session(self.table, "viewer", "ses-c").ended_at)

    def test_maintenance_removes_what_ran_out(self) -> None:
        save_session(
            self.table,
            Session(session_id="ses-old", user_id="viewer", created_at="2026-10-01T00:00:00Z", expires_at="2026-10-08T00:00:00Z", last_seen_at="2026-10-01T00:00:00Z"),
            updated_at=NOW,
        )
        save_session(
            self.table,
            Session(session_id="ses-new", user_id="viewer", created_at=NOW, expires_at="2026-10-20T00:00:00Z", last_seen_at=NOW),
            updated_at=NOW,
        )
        save_sign_in_guard(self.table, SignInGuard(email="old@example.com", failed_attempts=1, last_failed_at="2026-10-01T00:00:00Z"), updated_at=NOW)
        from midstream.storage.identity import append_audit_entry

        append_audit_entry(self.audit, AuditEntry(entry_id="aud-old", occurred_at="2026-01-01T00:00:00Z", action="user.created"))
        append_audit_entry(self.audit, AuditEntry(entry_id="aud-new", occurred_at="2026-10-12T00:00:00Z", action="user.created"))
        apply(self.table, self.audit, "maintenance", "system")
        self.assertIsNone(get_session(self.table, "viewer", "ses-old"))
        self.assertIsNotNone(get_session(self.table, "viewer", "ses-new"))
        self.assertIsNone(get_sign_in_guard(self.table, "old@example.com"))
        remaining = [entry.entry_id for _, entry in iter_audit_entries(self.audit, newest=NOW, oldest="2025-01-01")]
        self.assertEqual(remaining, ["aud-new"])

    def test_directory_view_finds_administrators(self) -> None:
        self.assertEqual(DirectoryView.load(self.table).administrators(), {"admin"})


PASSWORD = "correct horse battery staple"


def run(awaitable):
    return asyncio.run(awaitable)


class SignInTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_grants_cache()
        self.table, _ = directory()

    def sign_in(self, body: Any, **kwargs: Any) -> auth.AuthResult:
        return run(auth.sign_in(self.table, body, request=http_request(), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH, **kwargs))

    def test_a_correct_password_starts_a_session(self) -> None:
        result = self.sign_in({"email": " Viewer@Example.com ", "password": PASSWORD})
        self.assertEqual(result.status, 200)
        claims = _peek(result.body["token"])
        self.assertEqual(claims.user_id, "viewer")
        self.assertEqual(claims.expires_at - NOW_EPOCH, CONFIG.session_idle_timeout_minutes * 60)
        self.assertEqual(claims.session_expires_at - NOW_EPOCH, CONFIG.session_max_lifetime_hours * 3600)
        self.assertEqual(result.body["principal"]["email"], "viewer@example.com")
        self.assertTrue(result.body["authenticated"])
        self.assertEqual(result.request_event.action, "sign_in_succeeded")
        self.assertEqual(result.request_event.payload["session_id"], claims.session_id)
        self.assertEqual(result.body["session"]["refresh_after"], "2026-10-13T12:10:00Z")
        principal = authorize(http_request(result.body["token"]), self.table, "data.query", dataset="shop", secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual(principal.user_id, "viewer")

    def test_a_wrong_password_and_an_unknown_email_read_the_same(self) -> None:
        wrong = self.sign_in({"email": "viewer@example.com", "password": "not the password"})
        unknown = self.sign_in({"email": "nobody@example.com", "password": "not the password"})
        for result in (wrong, unknown):
            self.assertEqual(result.status, 401)
            self.assertEqual(result.body["error"]["message"], "Email or password is incorrect.")
            self.assertEqual(result.request_event.action, "sign_in_failed")
        self.assertEqual(wrong.request_event.payload["reason"], "wrong_password")
        self.assertEqual(unknown.request_event.payload["reason"], "unknown_email")
        self.assertNotIn("not the password", json.dumps(wrong.request_event.to_dict()))

    def test_a_locked_out_email_is_refused_without_checking_the_password(self) -> None:
        save_sign_in_guard(
            self.table,
            SignInGuard(email="viewer@example.com", failed_attempts=10, locked_until="2026-10-13T12:10:00Z"),
            updated_at=NOW,
        )
        with patch.object(auth, "verify_password_async") as verify:
            result = self.sign_in({"email": "viewer@example.com", "password": PASSWORD})
        verify.assert_not_called()
        self.assertEqual(result.status, 429)
        self.assertRegex(result.body["error"]["message"], "10 minutes")
        self.assertIsNone(result.request_event)

    def test_a_deactivated_account_says_so_only_to_its_password(self) -> None:
        save_user(self.table, replace(get_user(self.table, "viewer"), status="deactivated"))
        result = self.sign_in({"email": "viewer@example.com", "password": PASSWORD})
        self.assertEqual(result.status, 403)
        self.assertEqual(result.body["error"]["details"]["reason"], "account_deactivated")
        self.assertEqual(self.sign_in({"email": "viewer@example.com", "password": "wrong password"}).status, 401)

    def test_a_flood_of_sign_ins_is_turned_away_rather_than_queued(self) -> None:
        with patch("midstream.identity.passwords.MAX_QUEUED_HASHES", 0):
            result = self.sign_in({"email": "viewer@example.com", "password": PASSWORD})
        self.assertEqual(result.status, 429)
        self.assertEqual(result.body["error"]["details"]["reason"], "busy")
        self.assertIsNone(result.request_event)

    def test_without_a_signing_key_nobody_signs_in(self) -> None:
        result = run(auth.sign_in(self.table, {"email": "a@b.co", "password": "x"}, config=CONFIG, secrets=IdentitySecrets(), now=NOW_EPOCH))
        self.assertEqual(result.status, 503)

    def test_missing_fields(self) -> None:
        self.assertEqual(self.sign_in(None).status, 400)
        self.assertEqual(self.sign_in({"email": "viewer@example.com"}).body["error"]["details"]["field"], "password")

    def test_a_password_change_is_required_first(self) -> None:
        user = get_user(self.table, "viewer")
        save_user(self.table, replace(user, password=replace(user.password, must_change=True)))
        result = self.sign_in({"email": "viewer@example.com", "password": PASSWORD})
        self.assertEqual(result.status, 200)
        self.assertTrue(result.body["principal"]["password_change_required"])


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_grants_cache()
        self.table, _ = directory()
        self.viewer = get_user(self.table, "viewer")
        self.token = session_token(self.viewer)

    def test_session_view_reports_guests_people_and_expired_sessions(self) -> None:
        guest = auth.session_view(self.table, http_request(), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH)
        self.assertFalse(guest["authenticated"])
        self.assertEqual(guest["principal"]["kind"], "guest")
        self.assertEqual(guest["providers"][0]["id"], "password")
        self.assertEqual(guest["password_policy"]["min_length"], CONFIG.password_min_length)
        person = auth.session_view(self.table, http_request(self.token), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH)
        self.assertTrue(person["authenticated"])
        self.assertIn("datasets.view", person["principal"]["permissions"])
        self.assertNotIn("data.query", person["principal"]["permissions"])
        # What they hold on each dataset, beyond what they hold everywhere.
        self.assertEqual(
            {SHOP: ["catalog.read", "data.export", "data.query", "dataset.view_schema"]},
            person["principal"]["dataset_permissions"],
        )
        self.assertNotIn("token", person)
        expired = auth.session_view(self.table, http_request(session_token(self.viewer, expires=-1)), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual(expired["session_error"], "session_expired")
        self.assertFalse(expired["authenticated"])

    def test_refresh_restarts_the_idle_timeout_but_not_the_maximum(self) -> None:
        later = NOW_EPOCH + 600
        result = auth.refresh_session(self.table, http_request(self.token), config=CONFIG, secrets=SECRETS, now=later)
        claims = _peek(result.body["token"])
        self.assertEqual(claims.session_id, "ses-1")
        self.assertEqual(claims.expires_at, later + CONFIG.session_idle_timeout_minutes * 60)
        self.assertEqual(claims.session_expires_at, NOW_EPOCH + 86400)
        self.assertEqual(result.request_event.action, "session_refreshed")
        near_end = NOW_EPOCH + 86400 - 60
        token = session_token(self.viewer, expires=86400 - 30)
        capped = _peek(auth.refresh_session(self.table, http_request(token), config=CONFIG, secrets=SECRETS, now=near_end).body["token"])
        self.assertEqual(capped.expires_at, NOW_EPOCH + 86400)

    def test_sign_out(self) -> None:
        result = auth.sign_out(self.table, http_request(self.token), {"scope": "others"}, secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual(result.request_event.payload["scope"], "others")
        self.assertEqual(result.request_event.payload["session_id"], "ses-1")
        stale = auth.sign_out(self.table, http_request("v1.bad.token"), None, secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual((stale.status, stale.request_event), (200, None))
        with self.assertRaises(WebError):
            auth.sign_out(self.table, http_request(self.token), {"scope": "session"}, secrets=SECRETS, now=NOW_EPOCH)

    def test_change_password(self) -> None:
        with patch("midstream.identity.authorization.get_identity_secrets", return_value=SECRETS), patch(
            "midstream.identity.authorization._now", return_value=NOW_EPOCH
        ):
            request = http_request(self.token)
            with self.assertRaises(WebError) as wrong:
                run(auth.change_password(self.table, request, {"current_password": "nope", "new_password": "a brand new passphrase"}, config=CONFIG))
            self.assertEqual(wrong.exception.details["field"], "current_password")
            with self.assertRaises(WebError) as weak:
                run(auth.change_password(self.table, request, {"current_password": PASSWORD, "new_password": "short"}, config=CONFIG))
            self.assertEqual(weak.exception.details["field"], "new_password")
            accepted = run(
                auth.change_password(self.table, request, {"current_password": PASSWORD, "new_password": "a brand new passphrase"}, config=CONFIG)
            )
            with patch("midstream.identity.passwords.MAX_QUEUED_HASHES", 0), self.assertRaises(WebError) as busy:
                run(auth.change_password(self.table, request, {"current_password": PASSWORD, "new_password": "a brand new passphrase"}, config=CONFIG))
            self.assertEqual((busy.exception.status_code, busy.exception.details["reason"]), (429, "busy"))
        event = accepted.request_event.to_dict()
        self.assertEqual(event["action"], "change_password")
        self.assertTrue(event["payload"]["password_hash"].startswith("$scrypt$"))
        self.assertNotIn("a brand new passphrase", json.dumps(event))
        self.assertNotIn(PASSWORD, json.dumps(event))


class StartingTests(unittest.TestCase):
    """A restarted control plane answers before it has read its tables back: 503 until it has.

    On a test cluster a restart answered "invalid session" for those seconds, and the console, told a
    session had ended, cleared its cookie: everyone with a tab open was signed out.
    """

    def setUp(self) -> None:
        clear_grants_cache()
        self.table, _ = directory()
        self.viewer = get_user(self.table, "viewer")
        self.recovered = threading.Event()
        # What Kaspr binds is the Faust table, whose app says when its tables have been read back.
        self.table.app = SimpleNamespace(tables=SimpleNamespace(recovery=SimpleNamespace(completed=self.recovered)))

    def refused(self, call) -> WebError:
        with self.assertRaises(WebError) as caught:
            call()
        return caught.exception

    def test_every_caller_waits_until_the_directory_is_read_back(self) -> None:
        for token in (session_token(self.viewer), None, SECRETS.service_token):
            error = self.refused(lambda: authorize(http_request(token), self.table, "materializations.view", secrets=SECRETS, now=NOW_EPOCH))
            self.assertEqual((503, "starting"), (error.status_code, error.details["reason"]))
        self.recovered.set()
        principal = authorize(http_request(session_token(self.viewer)), self.table, "materializations.view_details", secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual(("user", "viewer@example.com"), (principal.kind, principal.email))

    def test_the_session_view_says_starting_rather_than_signed_out(self) -> None:
        error = self.refused(lambda: auth.session_view(self.table, http_request(session_token(self.viewer)), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH))
        self.assertEqual((503, "starting"), (error.status_code, error.details["reason"]))
        self.recovered.set()
        self.assertTrue(auth.session_view(self.table, http_request(session_token(self.viewer)), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH)["authenticated"])

    def test_signing_in_and_out_wait_too_and_count_nothing(self) -> None:
        result = run(auth.sign_in(self.table, {"email": "viewer@example.com", "password": PASSWORD}, request=http_request(), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH))
        self.assertEqual((503, "starting"), (result.status, result.body["error"]["details"]["reason"]))
        self.assertIsNone(result.request_event, "no failed sign-in is counted against the person")
        error = self.refused(lambda: auth.sign_out(self.table, http_request(session_token(self.viewer)), {}, secrets=SECRETS, now=NOW_EPOCH))
        self.assertEqual(503, error.status_code)

    def test_a_table_that_is_not_an_apps_is_ready(self) -> None:
        self.assertTrue(directory_ready(FakeTable()))
        self.assertTrue(directory_ready(None))
        self.assertFalse(directory_ready(self.table))


class DirectoryViewTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_grants_cache()
        self.table, self.audit = directory()
        self.admin = self.principal("admin")
        self.manager = self.principal("manager")
        self.viewer = self.principal("viewer")

    def principal(self, user_id: str):
        token = session_token(get_user(self.table, user_id))
        return authorize(http_request(token), self.table, None, secrets=SECRETS, now=NOW_EPOCH)

    def test_users_list_counts_filters_and_searches(self) -> None:
        save_sign_in_guard(self.table, SignInGuard(email="viewer@example.com", failed_attempts=10, locked_until="2099-01-01T00:00:00Z"), updated_at=NOW)
        listing = views.list_users_view(self.table, self.admin, {"sort": "name"})
        self.assertEqual(listing["counts"]["all"], 3)
        self.assertEqual(listing["counts"]["locked"], 1)
        self.assertEqual([user["user_id"] for user in listing["users"]], ["admin", "manager", "viewer"])
        manager_view = views.list_users_view(self.table, self.manager)
        admin_row = next(user for user in manager_view["users"] if user["user_id"] == "admin")
        self.assertFalse(admin_row["manageable"], "a user manager cannot manage an administrator")
        self.assertTrue(next(user for user in manager_view["users"] if user["user_id"] == "viewer")["manageable"])
        found = views.list_users_view(self.table, self.admin, {"q": "VIEW"})
        self.assertEqual([user["user_id"] for user in found["users"]], ["viewer"])
        with self.assertRaises(WebError):
            views.list_users_view(self.table, self.viewer)

    def test_user_detail_explains_where_each_permission_comes_from(self) -> None:
        detail = views.get_user_view(self.table, self.admin, "viewer")
        details = next(item for item in detail["permissions"] if item["key"] == "materializations.view_details")
        self.assertEqual(
            details["via"],
            [
                {"group_id": "all-users", "group": "All Users", "role_id": "viewer", "role": "Viewer"},
                {"group_id": "viewer", "group": "Viewer", "role_id": "viewer", "role": "Viewer"},
            ],
        )
        # What they hold on datasets, and through which group.
        self.assertEqual(
            [{"dataset_id": SHOP, "dataset": "shop", "principal_type": "group", "principal_id": "viewer", "via_group": "Viewer",
              "roles": [{"role_id": "dataset-reader", "name": "Dataset Reader", "built_in": True}]}],
            detail["dataset_grants"],
        )
        self.assertEqual([item["group_id"] for item in detail["memberships"]], ["guest", "all-users", "viewer"])
        with self.assertRaises(WebError) as missing:
            views.get_user_view(self.table, self.admin, "usr-none")
        self.assertEqual(missing.exception.status_code, 404)

    def test_create_user_validates_and_never_publishes_the_password(self) -> None:
        def create(principal, body):
            return run(views.create_user_request(self.table, principal, body, config=CONFIG))

        with self.assertRaises(WebError) as bad_email:
            create(self.admin, {"first_name": "A", "last_name": "B", "email": "nope", "password": "long enough password"})
        self.assertEqual(bad_email.exception.details["field"], "email")
        with self.assertRaises(WebError) as weak:
            create(self.admin, {"first_name": "A", "last_name": "B", "email": "a@example.com", "password": "short"})
        self.assertEqual(weak.exception.details["field"], "password")
        with self.assertRaises(WebError) as taken:
            create(self.admin, {"first_name": "A", "last_name": "B", "email": "viewer@example.com", "password": "long enough password"})
        self.assertEqual(taken.exception.status_code, 409)
        with self.assertRaises(WebError) as escalation:
            create(self.manager, {"first_name": "A", "last_name": "B", "email": "a@example.com", "password": "long enough password", "group_ids": ["admin"]})
        self.assertEqual(escalation.exception.status_code, 403)
        with self.assertRaises(WebError) as unknown_field:
            create(self.admin, {"first_name": "A", "last_name": "B", "email": "a@example.com", "password": "long enough password", "role": "x"})
        self.assertEqual(unknown_field.exception.details["field"], "role")
        accepted = create(self.admin, {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", "password": "long enough password", "group_ids": ["editor"]})
        event = accepted.request_event.to_dict()
        self.assertEqual(accepted.response["entity_type"], "user")
        self.assertEqual(accepted.response["status_url"], f"/identity/requests/{event['request_id']}")
        self.assertTrue(event["payload"]["password_hash"].startswith("$scrypt$ln="))
        self.assertNotIn("long enough password", json.dumps(event))

    def test_setting_a_password_while_hashing_is_busy_asks_to_try_again(self) -> None:
        with patch("midstream.identity.passwords.MAX_QUEUED_HASHES", 0):
            with self.assertRaises(WebError) as create:
                run(views.create_user_request(
                    self.table,
                    self.admin,
                    {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", "password": "long enough password"},
                    config=CONFIG,
                ))
            with self.assertRaises(WebError) as reset:
                run(views.set_user_password_request(self.table, self.admin, "viewer", {"password": "long enough password"}, config=CONFIG))
        for refused in (create.exception, reset.exception):
            self.assertEqual((refused.status_code, refused.details["reason"]), (429, "busy"))

    def test_changes_the_agent_would_refuse_are_refused_at_once(self) -> None:
        with self.assertRaises(WebError) as last:
            views.update_user_request(self.table, self.admin, "admin", {"group_ids": []}, config=CONFIG)
        self.assertEqual((last.exception.status_code, last.exception.details["reason"]), (409, "last_administrator"))
        with self.assertRaises(WebError) as nothing:
            views.update_user_request(self.table, self.admin, "viewer", {"base_revision": 1}, config=CONFIG)
        self.assertEqual(nothing.exception.status_code, 400)
        with self.assertRaises(WebError) as stale:
            views.update_user_request(self.table, self.admin, "viewer", {"first_name": "X", "base_revision": 9}, config=CONFIG)
        self.assertEqual(stale.exception.details["reason"], "changed")
        accepted = views.update_user_request(self.table, self.admin, "viewer", {"status": "deactivated", "base_revision": 1}, config=CONFIG)
        self.assertEqual(accepted.request_event.base_revision, 1)
        with self.assertRaises(WebError) as built_in:
            views.delete_group_request(self.table, self.admin, "viewer", config=CONFIG)
        self.assertEqual(built_in.exception.details["reason"], "built_in")
        with self.assertRaises(WebError) as by_guest:
            views.create_group_request(self.table, authorize(http_request(), self.table, None, secrets=SECRETS), {"name": "X"}, config=CONFIG)
        self.assertEqual(by_guest.exception.status_code, 401)

    def test_groups_and_roles(self) -> None:
        groups = views.list_groups_view(self.table, self.admin)
        self.assertEqual([group["group_id"] for group in groups["groups"]][:5], ["guest", "all-users", "viewer", "editor", "admin"])
        admin_group = next(group for group in groups["groups"] if group["group_id"] == "admin")
        self.assertEqual((admin_group["member_count"], admin_group["locked_role_ids"]), (1, ["administrator"]))
        manager_groups = {group["group_id"]: group for group in views.list_groups_view(self.table, self.manager)["groups"]}
        self.assertTrue(manager_groups["editor"]["grantable"])
        self.assertFalse(manager_groups["admin"]["grantable"], "a user manager cannot hand out Admin")
        self.assertIsNone(next(group for group in groups["groups"] if group["group_id"] == "guest")["member_count"])
        detail = views.get_group_view(self.table, self.admin, "editor")
        self.assertEqual([member["user_id"] for member in detail["members"]], ["manager"])
        roles = views.list_roles_view(self.table, self.admin)
        administrator = next(role for role in roles["roles"] if role["role_id"] == "administrator")
        self.assertTrue(administrator["all_permissions"])
        self.assertEqual(administrator["groups"], [{"group_id": "admin", "name": "Admin"}])
        catalog = views.permissions_view(self.viewer)
        self.assertEqual(catalog["categories"][0]["id"], "users")
        with self.assertRaises(WebError):
            views.permissions_view(authorize(http_request(), self.table, None, secrets=SECRETS))

    def test_audit_pages_newest_first(self) -> None:
        for index in range(5):
            append_audit_entry(
                self.audit,
                AuditEntry(entry_id=f"aud-{index}", occurred_at=f"2026-10-13T0{index}:00:00Z", action="user.created" if index % 2 else "session.signed_in"),
            )
        from datetime import UTC, datetime

        now = datetime(2026, 10, 13, 12, tzinfo=UTC)
        first = views.audit_view(self.audit, self.admin, {"limit": "2"}, config=CONFIG, now=now)
        self.assertEqual([entry["entry_id"] for entry in first["entries"]], ["aud-4", "aud-3"])
        second = views.audit_view(self.audit, self.admin, {"limit": "2", "before": first["next"]}, config=CONFIG, now=now)
        self.assertEqual([entry["entry_id"] for entry in second["entries"]], ["aud-2", "aud-1"])
        users_only = views.audit_view(self.audit, self.admin, {"action": "user."}, config=CONFIG, now=now)
        self.assertEqual([entry["entry_id"] for entry in users_only["entries"]], ["aud-3", "aud-1"])
        with self.assertRaises(WebError):
            views.audit_view(self.audit, self.viewer, {}, config=CONFIG, now=now)

    def test_request_outcomes_are_for_their_sender(self) -> None:
        self.assertEqual(views.identity_request_view(self.table, self.viewer, "idr-unknown")["status"], "pending")
        save_request_outcome(
            self.table,
            IdentityRequestOutcome(request_id="idr-1", action="update_user", status="applied", completed_at=NOW, actor_id="admin"),
        )
        self.assertEqual(views.identity_request_view(self.table, self.admin, "idr-1")["status"], "applied")
        with self.assertRaises(WebError):
            views.identity_request_view(self.table, self.viewer, "idr-1")


if __name__ == "__main__":
    unittest.main()


class AccessTokenTests(unittest.TestCase):
    """Tokens for external tools: made once, kept hashed, never more than their owner holds."""

    NOW_DATETIME = datetime(2026, 10, 13, 12, tzinfo=UTC)

    def setUp(self) -> None:
        clear_grants_cache()
        self.table, self.audit = directory()
        self.viewer = get_user(self.table, "viewer")
        self.admin = get_user(self.table, "admin")

    def principal_of(self, user: User):
        return authorize(http_request(session_token(user)), self.table, None, secrets=SECRETS, now=NOW_EPOCH)

    def make(self, user: User, body: dict | None = None) -> dict:
        from midstream.web.tokens import create_access_token_request

        acceptance = create_access_token_request(
            self.principal_of(user),
            {"name": "DuckDB on my laptop"} if body is None else body,
            request=http_request(),
            directory_table=self.table,
            secrets=SECRETS,
            now=self.NOW_DATETIME,
        )
        outcome = apply_identity_request(self.table, self.audit, acceptance.request_event, config=CONFIG, secrets=SECRETS, applied_at=NOW)
        self.assertEqual("applied", outcome.status, outcome.to_dict())
        return acceptance.response

    def audit_entries(self) -> list[AuditEntry]:
        return [AuditEntry.from_dict(value["payload"]) for _, value in self.audit.prefix_scan("audit:")]

    def use(self, token: str, permission: str | None = "catalog.read", *, now: int = NOW_EPOCH):
        """Use a token as the catalog does: for a permission on some dataset."""
        clear_grants_cache()
        if permission in DATASET_PERMISSION_KEYS:
            return authorize(http_request(token), self.table, permission, any_dataset=True, secrets=SECRETS, now=now)
        return authorize(http_request(token), self.table, permission, secrets=SECRETS, now=now)

    def test_a_token_is_shown_once_signed_and_carries_only_its_permissions(self) -> None:
        from midstream.identity.access_tokens import read_access_token

        response = self.make(self.admin)

        self.assertTrue(response["token"].startswith("tok_"))
        # The directory never holds the token's text: any domain checks its signature instead.
        self.assertNotIn(response["token"].split(".")[-1], json.dumps(self.table.data))
        claims = read_access_token(response["token"], SECRETS, now=NOW_EPOCH)
        self.assertEqual((response["token_id"], "admin@example.com", ("catalog.read",)), (claims.token_id, claims.owner.email, claims.permissions))
        self.assertEqual(claims.expires_at - claims.issued_at, 90 * 86400)
        principal = self.use(response["token"])
        self.assertEqual(("token", "admin"), (principal.kind, principal.user_id))
        # An administrator's token still carries only what it was made with.
        self.assertTrue(principal.can("catalog.read"))
        self.assertTrue(principal.can("catalog.read", SHOP))
        self.assertFalse(principal.can("catalog.write"))
        self.assertFalse(principal.can("catalog.write", SHOP))
        self.assertFalse(principal.can("users.manage"))
        self.assertEqual(response["token_id"], principal.access_token_id)
        self.assertEqual(["token.created"], [entry.action for entry in self.audit_entries()])

    def test_a_token_cannot_carry_what_its_owner_lacks(self) -> None:
        from midstream.web.tokens import create_access_token_request

        with self.assertRaises(WebError) as caught:
            create_access_token_request(
                self.principal_of(self.viewer),
                {"name": "writer", "permissions": ["catalog.write"]},
                request=http_request(),
                directory_table=self.table,
                secrets=SECRETS,
                now=self.NOW_DATETIME,
            )
        self.assertEqual(403, caught.exception.status_code)
        outcome = apply(
            self.table,
            self.audit,
            "create_access_token",
            "viewer",
            {"token_id": "a" * 12, "name": "sneaky", "permissions": ["catalog.write"], "expires_at": "2026-11-13T12:00:00Z", "issuer": "default"},
        )
        self.assertEqual("rejected", outcome.status)
        # A token the agent refuses must not work anywhere: it is revoked as it is refused.
        from midstream.storage.identity import get_token_revocation

        self.assertIsNotNone(get_token_revocation(self.table, "a" * 12))
        for body in ({"name": "x", "permissions": ["users.manage"]}, {"name": ""}, {"name": "x", "expires_in_days": 999}, {"name": "x", "color": "red"}):
            with self.subTest(body=body), self.assertRaises(WebError):
                create_access_token_request(self.principal_of(self.viewer), body, request=http_request(), directory_table=self.table, secrets=SECRETS, now=self.NOW_DATETIME)

    def test_a_token_narrows_with_its_owner_and_stops_when_they_are_deactivated(self) -> None:
        token = self.make(self.viewer)["token"]
        self.use(token)

        save_user(self.table, replace(self.viewer, group_ids=[]))
        # The Viewer group read the dataset; All Users, still theirs, grants no catalog access.
        with self.assertRaises(WebError) as caught:
            self.use(token)
        self.assertEqual(403, caught.exception.status_code)

        save_user(self.table, replace(self.viewer, status="deactivated"))
        with self.assertRaises(WebError) as caught:
            self.use(token, None)
        self.assertEqual("account_deactivated", caught.exception.details["reason"])

    def test_revoked_expired_and_forged_tokens_are_refused(self) -> None:
        response = self.make(self.viewer, {"name": "short", "expires_in_days": 1})
        token = response["token"]
        with self.assertRaises(WebError) as caught:
            self.use(token, now=NOW_EPOCH + 2 * 86400)
        self.assertEqual("token_expired", caught.exception.details["reason"])

        forged = token[:-4] + "AAAA"
        with self.assertRaises(WebError) as caught:
            self.use(forged)
        self.assertEqual("invalid_token", caught.exception.details["reason"])
        with self.assertRaises(WebError):
            self.use("tok_not-a-token")

        apply(self.table, self.audit, "revoke_access_token", "viewer", {"token_id": response["token_id"]})
        with self.assertRaises(WebError) as caught:
            self.use(token)
        self.assertEqual("token_revoked", caught.exception.details["reason"])

    def test_a_token_cannot_make_another(self) -> None:
        from midstream.web.tokens import create_access_token_request

        token = self.make(self.viewer)["token"]
        with self.assertRaises(WebError) as caught:
            create_access_token_request(self.use(token), {"name": "again"}, request=http_request(), directory_table=self.table, secrets=SECRETS, now=self.NOW_DATETIME)
        self.assertEqual("session_required", caught.exception.details["reason"])

    def test_people_see_and_revoke_only_their_own_tokens(self) -> None:
        from midstream.web.tokens import my_access_tokens_view, revoke_access_token_request

        mine = self.make(self.viewer)
        self.make(self.admin)

        listed = my_access_tokens_view(self.table, self.principal_of(self.viewer), now=self.NOW_DATETIME)
        self.assertEqual([mine["token_id"]], [item["token_id"] for item in listed["tokens"]])
        self.assertNotIn("token", listed["tokens"][0])
        self.assertTrue(listed["tokens"][0]["active"])
        self.assertEqual({"catalog.read": True, "catalog.write": False}, {item["key"]: item["granted"] for item in listed["permissions"]})

        admins = [token for token in my_access_tokens_view(self.table, self.principal_of(self.admin))["tokens"]]
        with self.assertRaises(WebError) as caught:
            revoke_access_token_request(self.table, self.principal_of(self.viewer), admins[0]["token_id"], request=http_request(), secrets=SECRETS)
        self.assertEqual(404, caught.exception.status_code)
        accepted = revoke_access_token_request(self.table, self.principal_of(self.viewer), mine["token_id"], request=http_request(), secrets=SECRETS)
        self.assertEqual("revoke_access_token", accepted.request_event.action)
        # The revocation, signed, for the console to hand to every other domain.
        from midstream.identity.access_tokens import read_revocation

        self.assertEqual(mine["token_id"], read_revocation(accepted.response["revocation"], SECRETS).token_id)

    def test_tokens_go_with_their_owner_and_old_revoked_ones_are_cleaned_up(self) -> None:
        from midstream.storage.identity import get_access_token

        response = self.make(self.viewer)
        apply(self.table, self.audit, "revoke_access_token", "viewer", {"token_id": response["token_id"]})
        apply_identity_request(
            self.table,
            self.audit,
            request("maintenance", "system"),
            config=CONFIG,
            secrets=SECRETS,
            applied_at="2026-10-25T12:00:00Z",
        )
        self.assertIsNone(get_access_token(self.table, response["token_id"]))

        kept = self.make(self.viewer)
        save_user(self.table, replace(self.viewer, status="deactivated"))
        apply(self.table, self.audit, "delete_user", "admin", {"user_id": "viewer"})
        self.assertIsNone(get_access_token(self.table, kept["token_id"]))


class InvitationTests(unittest.TestCase):
    """Invitations (handbook 18 §18.18): an account made by email before its person signs in, holding
    the access chosen for them, accepted at their first sign-in."""

    LATER = datetime(2026, 10, 13, 12, tzinfo=UTC)

    def setUp(self) -> None:
        clear_grants_cache()
        self.table, self.audit = directory()
        # Someone who may invite and nothing more about users: a custom role, through a group.
        from midstream.storage.identity import save_group, save_role

        save_role(self.table, Role(role_id="rol-inviter", name="Inviter", permissions=["users.invite"], created_at=NOW, created_by="system", updated_at=NOW, updated_by="system"))
        save_group(self.table, Group(group_id="grp-inviters", name="Inviters", role_ids=["rol-inviter"], created_at=NOW, created_by="system", updated_at=NOW, updated_by="system"))
        store_user(self.table, make_user("inviter", "inviter@example.com", groups=["grp-inviters"]))
        # A group whose access everyone signed in holds already, which anyone who may invite may give.
        save_group(self.table, Group(group_id="grp-lookers", name="Lookers", role_ids=["viewer"], created_at=NOW, created_by="system", updated_at=NOW, updated_by="system"))

    def principal(self, user_id: str):
        clear_grants_cache()
        return authorize(http_request(session_token(get_user(self.table, user_id))), self.table, None, secrets=SECRETS, now=NOW_EPOCH)

    def invite(self, actor: str, emails: list[str], groups: list[str] | None = None, *, config: ControlPlaneConfig = CONFIG) -> dict[str, Any]:
        acceptance = views.invite_users_request(
            self.table, self.principal(actor), {"emails": emails, "group_ids": groups or []}, request=http_request(), config=config, now=self.LATER
        )
        outcome = apply_identity_request(self.table, self.audit, acceptance.request_event, config=config, secrets=SECRETS, applied_at=NOW)
        self.assertEqual("applied", outcome.status, outcome.to_dict())
        return acceptance.response

    def accept(self, token: str, **fields: Any) -> auth.AuthResult:
        body = {"token": token, "first_name": "Ada", "last_name": "Lovelace", "password": "analytical engines", **fields}
        return run(auth.accept_invitation(self.table, body, request=http_request(), config=fields.pop("config", CONFIG) if "config" in fields else CONFIG, secrets=SECRETS, now=NOW_EPOCH))

    def audited(self) -> list[str]:
        return [AuditEntry.from_dict(value["payload"]).action for _, value in self.audit.prefix_scan("audit:")]

    def test_each_email_becomes_an_invited_account_holding_the_groups(self) -> None:
        response = self.invite("admin", ["ada@example.com", " Bob@Example.com "], ["editor"])

        self.assertEqual(["ada@example.com", "bob@example.com"], [item["email"] for item in response["invitations"]])
        for item in response["invitations"]:
            user = get_user(self.table, item["user_id"])
            self.assertEqual(("invited", ["editor"], "", None), (user.status, user.group_ids, user.first_name, user.password))
            self.assertEqual(user.email, user.display_name)
            self.assertEqual("admin@example.com", user.invitation.invited_by)
            self.assertEqual("2026-10-20T12:00:00Z", user.invitation.link_expires_at)
            self.assertTrue(item["link"].startswith(f"inv_{item['user_id']}."))
            # The directory holds the link's hash, never the link.
            self.assertNotIn(item["link"].rsplit(".", 1)[1], json.dumps(self.table.data))
            self.assertEqual(item["user_id"], find_user_by_email(self.table, item["email"]).user_id)
        self.assertEqual(2, self.audited().count("user.invited"))
        # An invited account holds what its groups give, and is no administrator.
        invited = get_user(self.table, response["invitations"][0]["user_id"])
        self.assertIn("materializations.create", DirectoryView.load(self.table).grants_for_user(invited).permissions)
        listing = views.list_users_view(self.table, self.principal("admin"), {"status": "invited"})
        self.assertEqual((2, 2, 4), (listing["returned"], listing["counts"]["invited"], listing["counts"]["active"]))
        row = listing["users"][0]
        self.assertEqual(("invited", "2026-10-20T12:00:00Z"), (row["status"], row["invitation"]["link_expires_at"]))
        self.assertNotIn("link_hash", json.dumps(views.get_user_view(self.table, self.principal("admin"), row["user_id"])))

    def test_every_email_is_checked_before_any_is_invited(self) -> None:
        self.invite("admin", ["ada@example.com"])
        with self.assertRaises(WebError) as caught:
            views.invite_users_request(
                self.table,
                self.principal("admin"),
                {"emails": ["viewer@example.com", "not-an-email", "new@example.com", "NEW@example.com", "ada@example.com"]},
                request=http_request(),
                config=CONFIG,
            )
        self.assertEqual(400, caught.exception.status_code)
        problems = {problem["index"]: (problem["reason"], problem["message"]) for problem in caught.exception.details["problems"]}
        self.assertEqual(
            {
                0: ("already_exists", "viewer@example.com already has an account."),
                1: ("invalid", "Enter a valid email address, such as jane@example.com"),
                3: ("duplicate", "new@example.com is named twice."),
                4: ("invited", "ada@example.com is invited already."),
            },
            problems,
        )
        # An invitation says which, so a client can give it a new link rather than invite again.
        invited = next(problem for problem in caught.exception.details["problems"] if problem["reason"] == "invited")
        self.assertEqual(find_user_by_email(self.table, "ada@example.com").user_id, invited["user_id"])
        self.assertNotIn("user_id", caught.exception.details["problems"][0])
        with self.assertRaises(WebError) as caught:
            views.invite_users_request(self.table, self.principal("admin"), {"emails": ["viewer@example.com"]}, request=http_request(), config=CONFIG)
        self.assertEqual((409, "emails"), (caught.exception.status_code, caught.exception.details["field"]))
        for body in ({"emails": []}, {"emails": "ada@example.com"}, {"emails": [f"p{index}@example.com" for index in range(101)]}, {"emails": ["x@example.com"], "password": "x"}):
            with self.subTest(body=str(body)[:40]), self.assertRaises(WebError) as caught:
                views.invite_users_request(self.table, self.principal("admin"), body, request=http_request(), config=CONFIG)
            self.assertEqual(400, caught.exception.status_code)

    def test_nobody_invites_into_access_they_do_not_hold(self) -> None:
        # Inviting is its own permission; Manage users includes it.
        self.assertIn("users.invite", expand_permissions(["users.manage"]))
        self.assertTrue({"users.view_details", "users.view", "groups.view"} <= expand_permissions(["users.invite"]))
        with self.assertRaises(WebError) as caught:
            views.invite_users_request(self.table, self.principal("viewer"), {"emails": ["ada@example.com"]}, request=http_request(), config=CONFIG)
        self.assertEqual(403, caught.exception.status_code)
        with self.assertRaises(IdentityRejection) as refused:
            views.preview_identity_request(self.table, views.directory_request(self.principal("inviter"), "invite_users", {"invitations": [{"user_id": "usr-x", "email": "x@example.com"}], "group_ids": ["admin"]}, request=http_request()), config=CONFIG, secrets=SECRETS)
        self.assertEqual("forbidden", refused.exception.reason)
        with self.assertRaises(WebError) as caught:
            views.invite_users_request(self.table, self.principal("inviter"), {"emails": ["ada@example.com"], "group_ids": ["editor"]}, request=http_request(), config=CONFIG)
        self.assertEqual(403, caught.exception.status_code)
        # Groups whose access everyone signed in holds are theirs to give; so the User Manager's.
        self.assertEqual(1, len(self.invite("inviter", ["ada@example.com"], ["grp-lookers"])["invitations"]))
        self.assertEqual(1, len(self.invite("manager", ["bob@example.com"], ["editor"])["invitations"]))
        refused = apply(self.table, self.audit, "invite_users", "viewer", {"invitations": [{"user_id": "usr-y", "email": "y@example.com"}]})
        self.assertEqual("forbidden", refused.reason)

    def test_an_invitation_is_changed_and_revoked_by_whoever_may_invite(self) -> None:
        invited = self.invite("inviter", ["ada@example.com"], ["grp-lookers"])["invitations"][0]["user_id"]

        changed = views.update_user_request(self.table, self.principal("inviter"), invited, {"group_ids": [], "first_name": "Ada"}, request=http_request(), config=CONFIG)
        self.assertEqual("applied", apply_identity_request(self.table, self.audit, changed.request_event, config=CONFIG, secrets=SECRETS).status)
        self.assertEqual(([], "Ada", "invited"), (get_user(self.table, invited).group_ids, get_user(self.table, invited).first_name, get_user(self.table, invited).status))
        # Anyone else's account still needs Manage users.
        with self.assertRaises(WebError) as caught:
            views.update_user_request(self.table, self.principal("inviter"), "viewer", {"first_name": "Vera"}, request=http_request(), config=CONFIG)
        self.assertEqual(403, caught.exception.status_code)
        self.assertEqual("forbidden", apply(self.table, self.audit, "update_user", "inviter", {"user_id": "viewer", "first_name": "Vera"}).reason)
        # An invitation becomes active only when it is accepted, and nothing becomes an invitation.
        for user_id, status in ((invited, "active"), (invited, "deactivated"), ("viewer", "invited")):
            with self.subTest(user=user_id, status=status):
                self.assertEqual("invalid", apply(self.table, self.audit, "update_user", "admin", {"user_id": user_id, "status": status}).reason)
        self.assertEqual("invalid", apply(self.table, self.audit, "set_user_password", "admin", {"user_id": invited, "password_hash": HASH}).reason)

        with self.assertRaises(WebError) as caught:
            views.delete_user_request(self.table, self.principal("inviter"), "viewer", request=http_request(), config=CONFIG)
        self.assertEqual(403, caught.exception.status_code)
        # Shared a dataset the inviter cannot read, it holds access they lack: theirs no longer.
        store_dataset(self.table, "ds-000000000002", name="finance", grants={invited: ("user", "dataset-reader")})
        with self.assertRaises(WebError) as caught:
            views.delete_user_request(self.table, self.principal("inviter"), invited, request=http_request(), config=CONFIG)
        self.assertEqual(403, caught.exception.status_code)
        # Revoking needs no deactivating first: nobody ever used it.
        revoked = views.delete_user_request(self.table, self.principal("admin"), invited, request=http_request(), config=CONFIG)
        self.assertEqual("applied", apply_identity_request(self.table, self.audit, revoked.request_event, config=CONFIG, secrets=SECRETS).status)
        self.assertIsNone(get_user(self.table, invited))
        self.assertIsNone(find_user_by_email(self.table, "ada@example.com"))
        self.assertFalse(any(grant.principal_id == invited for grant in DirectoryView.load(self.table).dataset_grants.values()))
        self.assertIn("user.invitation_revoked", self.audited())

    def test_an_invitation_holding_more_than_the_inviter_is_theirs_to_leave_alone(self) -> None:
        invited = self.invite("admin", ["root@example.com"], [ADMIN_GROUP_ID])["invitations"][0]["user_id"]
        for action, payload in (("update_user", {"user_id": invited, "group_ids": []}), ("delete_user", {"user_id": invited}), ("renew_invitation", {"user_id": invited})):
            with self.subTest(action=action):
                self.assertEqual("forbidden", apply(self.table, self.audit, action, "inviter", payload).reason)

    def test_an_invitation_is_no_administrator_until_it_is_accepted(self) -> None:
        self.invite("admin", ["second@example.com"], [ADMIN_GROUP_ID])
        self.assertEqual({"admin"}, DirectoryView.load(self.table).administrators())
        refused = apply(self.table, self.audit, "update_user", "admin", {"user_id": "admin", "group_ids": []})
        self.assertEqual("last_administrator", refused.reason)

    def test_accepting_with_the_link_makes_the_account_theirs_and_signs_them_in(self) -> None:
        item = self.invite("admin", ["ada@example.com"], ["editor"])["invitations"][0]
        described = auth.describe_invitation(self.table, {"token": item["link"]}, config=CONFIG, now=NOW_EPOCH)
        self.assertEqual(
            ("ada@example.com", "Admin Person", "2026-10-20T12:00:00Z", True),
            (described["email"], described["invited_by"], described["link_expires_at"], described["password_sign_in"]),
        )

        result = self.accept(item["link"])
        self.assertEqual(200, result.status, result.body)
        self.assertEqual("accept_invitation", result.request_event.action)
        self.assertEqual({"user_id": item["user_id"], "request_id": result.request_event.request_id}, result.provisioning)
        self.assertNotIn("analytical engines", json.dumps(result.request_event.to_dict()))
        # Its session is not theirs until the agent has made the account theirs.
        self.assertEqual(503, run(auth.await_provisioned(self.table, result.to_value(), timeout=0.05))["status"])
        with self.assertRaises(WebError) as caught:
            authenticate(http_request(result.body["token"]), self.table, secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual("invalid_session", caught.exception.details["reason"])

        self.assertEqual("applied", apply_identity_request(self.table, self.audit, result.request_event, config=CONFIG, secrets=SECRETS, applied_at=NOW).status)
        self.assertEqual(200, run(auth.await_provisioned(self.table, result.to_value()))["status"])
        user = get_user(self.table, item["user_id"])
        self.assertEqual(("active", "Ada", "Lovelace", None, ["editor"]), (user.status, user.first_name, user.last_name, user.invitation, user.group_ids))
        self.assertFalse(user.password.must_change)
        self.assertTrue(verify_password("analytical engines", user.password.hash))
        self.assertIsNotNone(get_session(self.table, user.user_id, result.request_event.payload["session_id"]))
        self.assertTrue({"user.invitation_accepted", "session.signed_in"} <= set(self.audited()))
        principal = authenticate(http_request(result.body["token"]), self.table, secrets=SECRETS, now=NOW_EPOCH)
        self.assertTrue(principal.can("materializations.create"))
        # Spent: the link opens nothing now, and the password signs in.
        with self.assertRaises(WebError) as caught:
            auth.describe_invitation(self.table, {"token": item["link"]}, config=CONFIG, now=NOW_EPOCH)
        self.assertEqual((404, "invitation_invalid"), (caught.exception.status_code, caught.exception.details["reason"]))
        signed_in = run(auth.sign_in(self.table, {"email": "ada@example.com", "password": "analytical engines"}, request=http_request(), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH))
        self.assertEqual(200, signed_in.status)

    def test_a_link_that_does_not_work_says_only_that(self) -> None:
        item = self.invite("admin", ["ada@example.com"])["invitations"][0]
        user_id, secret = item["link"][len("inv_"):].rsplit(".", 1)
        forged = f"inv_{user_id}.{'A' * len(secret)}"
        for token in ("", "inv_", "nonsense", forged, f"inv_usr-000000000000.{secret}", None):
            with self.subTest(token=token):
                result = self.accept(token)
                self.assertEqual((404, "invitation_invalid"), (result.status, result.body["error"]["details"]["reason"]))
                self.assertIsNone(result.request_event)
        expired = run(auth.accept_invitation(self.table, {"token": item["link"], "first_name": "Ada", "last_name": "Lovelace", "password": "analytical engines"}, config=CONFIG, secrets=SECRETS, now=NOW_EPOCH + 7 * 86400))
        self.assertEqual((410, "invitation_expired"), (expired.status, expired.body["error"]["details"]["reason"]))

    def test_a_name_and_a_password_the_rules_refuse_are_refused(self) -> None:
        link = self.invite("admin", ["ada@example.com"])["invitations"][0]["link"]
        for fields, field in (({"password": "short"}, "password"), ({"password": "ada@example.com"}, "password"), ({"first_name": " "}, "first_name"), ({"last_name": None}, "last_name")):
            with self.subTest(fields=fields):
                result = self.accept(link, **fields)
                self.assertEqual(400, result.status)
                if field is not None:
                    self.assertEqual(field, result.body["error"]["details"]["field"])
        self.assertEqual(400, run(auth.accept_invitation(self.table, None, config=CONFIG, secrets=SECRETS, now=NOW_EPOCH)).status)
        self.assertEqual(503, run(auth.accept_invitation(self.table, {"token": link}, config=CONFIG, secrets=IdentitySecrets(), now=NOW_EPOCH)).status)

    def test_a_new_link_replaces_the_old_one_and_the_agent_checks_again(self) -> None:
        item = self.invite("admin", ["ada@example.com"])["invitations"][0]
        pending = self.accept(item["link"])
        renewed = views.renew_invitation_request(self.table, self.principal("inviter"), item["user_id"], request=http_request(), config=CONFIG, now=self.LATER)
        self.assertEqual("applied", apply_identity_request(self.table, self.audit, renewed.request_event, config=CONFIG, secrets=SECRETS).status)
        self.assertNotEqual(item["link"], renewed.response["link"])
        self.assertIn("user.invitation_renewed", self.audited())
        # The old link was good when the person sent it, and is not when the agent applies it.
        refused = apply_identity_request(self.table, self.audit, pending.request_event, config=CONFIG, secrets=SECRETS)
        self.assertEqual("invitation_invalid", refused.reason)
        self.assertEqual(409, run(auth.await_provisioned(self.table, pending.to_value()))["status"])
        self.assertEqual(404, self.accept(item["link"]).status)
        self.assertEqual(200, self.accept(renewed.response["link"]).status)
        for user_id, status in (("viewer", 409), ("usr-nobody", 404)):
            with self.subTest(user=user_id), self.assertRaises(WebError) as caught:
                views.renew_invitation_request(self.table, self.principal("admin"), user_id, request=http_request(), config=CONFIG)
            self.assertEqual(status, caught.exception.status_code)

    def test_while_password_sign_in_is_off_invitations_have_no_link(self) -> None:
        off = replace(CONFIG, password_sign_in_enabled=False)
        item = self.invite("admin", ["ada@example.com"], config=off)["invitations"][0]
        self.assertEqual((None, None), (item["link"], item["link_expires_at"]))
        self.assertIsNone(get_user(self.table, item["user_id"]).invitation.link_hash)
        with self.assertRaises(WebError) as caught:
            views.renew_invitation_request(self.table, self.principal("admin"), item["user_id"], request=http_request(), config=off)
        self.assertEqual((409, "password_sign_in_disabled"), (caught.exception.status_code, caught.exception.details["reason"]))
        # A link made while it was on works only for an invited administrator once it is off.
        viewer_link = self.invite("admin", ["bob@example.com"])["invitations"][0]["link"]
        admin_link = self.invite("admin", ["root@example.com"], [ADMIN_GROUP_ID])["invitations"][0]["link"]
        self.assertEqual((403, "password_sign_in_disabled"), (lambda result: (result.status, result.body["error"]["details"]["reason"]))(self.accept(viewer_link, config=off)))
        self.assertEqual(200, self.accept(admin_link, config=off).status)
        self.assertFalse(auth.describe_invitation(self.table, {"token": viewer_link}, config=off, now=NOW_EPOCH)["password_sign_in"])

    def test_an_invitation_is_not_an_account_until_it_is_accepted(self) -> None:
        from midstream.identity.access_tokens import TokenClaims, TokenOwner, new_token_id, sign_access_token

        invited = self.invite("admin", ["ada@example.com"], ["editor"])["invitations"][0]["user_id"]
        # No password, so nothing to sign in with - said as for any wrong password.
        result = run(auth.sign_in(self.table, {"email": "ada@example.com", "password": "anything at all"}, request=http_request(), config=CONFIG, secrets=SECRETS, now=NOW_EPOCH))
        self.assertEqual((401, "no_password"), (result.status, result.request_event.payload["reason"]))
        # Another domain's token for this email reads as someone this domain does not know.
        claims = TokenClaims(token_id=new_token_id(), issuer="domain_b", owner=TokenOwner(email="ada@example.com"), permissions=("catalog.read",), issued_at=NOW_EPOCH, expires_at=NOW_EPOCH + 3600)
        with self.assertRaises(WebError) as caught:
            authenticate(http_request(sign_access_token(claims, SECRETS)), self.table, secrets=SECRETS, now=NOW_EPOCH)
        self.assertEqual("token_unknown_owner", caught.exception.details["reason"])
        self.assertEqual("already_exists", apply(self.table, self.audit, "create_user", "admin", {"user_id": "usr-z", "email": "ada@example.com", "first_name": "A", "last_name": "B", "password_hash": HASH}).reason)
        self.assertEqual("invitation_accepted", apply(self.table, self.audit, "accept_invitation", invited, {"user_id": "viewer", "method": "password"}).reason)

    def test_the_bootstrap_administrator_takes_an_invitation_for_its_email(self) -> None:
        table, audit = FakeTable(), FakeTable()
        store_user(table, make_invited("usr-root", "root@example.com", groups=["viewer"]))
        apply_identity_request(table, audit, request("bootstrap", "system"), config=CONFIG, secrets=SECRETS, applied_at=NOW)
        user = get_user(table, "usr-root")
        self.assertEqual(("active", "Root", "Admin", None), (user.status, user.first_name, user.last_name, user.invitation))
        self.assertIn(ADMIN_GROUP_ID, user.group_ids)
        self.assertEqual({"usr-root"}, DirectoryView.load(table).administrators())

    def test_an_invitation_round_trips_and_an_invited_account_needs_one(self) -> None:
        user = make_invited("usr-ada", "ada@example.com", link_hash="0" * 64, link_expires_at="2026-10-20T12:00:00Z")
        self.assertEqual(user, User.from_dict(user.to_dict()))
        with self.assertRaises(ValueError):
            replace(user, invitation=None)
        with self.assertRaises(ValueError):
            replace(user, status="active", invitation=None)
        with self.assertRaises(ValueError):
            Invitation(invited_at=NOW, invited_by="a", link_hash="0" * 64)
        self.assertEqual("Ada Lovelace", replace(user, first_name="Ada", last_name="Lovelace").display_name)

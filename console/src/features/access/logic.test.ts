import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthProvider, CpPermissionCatalog } from '@shared/types';

import {
  AUDIT_ACTION_LABELS,
  PASSWORD_ALPHABET,
  auditActionLabel,
  describeAgent,
  describeDetail,
  describeMethod,
  expandPermissions,
  generatePassword,
  andList,
  invitationEntries,
  invitationLink,
  joinWays,
  joinSentence,
  joinWaysAcross,
  orList,
  parseEmails,
  refusalDetails,
  takenByAll,
} from './logic.ts';

const catalog: CpPermissionCatalog = {
  categories: [{ id: 'data', label: 'Data' }],
  permissions: [
    { key: 'materializations.view', category: 'materializations', label: 'View', description: '', implies: [], danger: false, scope: 'deployment' },
    {
      key: 'materializations.view_details',
      category: 'materializations',
      label: 'Details',
      description: '',
      implies: ['materializations.view'],
      danger: false,
      scope: 'deployment',
    },
    { key: 'dataset.view_schema', category: 'datasets', label: 'Schemas', description: '', implies: [], danger: false, scope: 'dataset' },
    { key: 'data.query', category: 'data', label: 'Query', description: '', implies: ['dataset.view_schema'], danger: false, scope: 'dataset' },
    { key: 'data.export', category: 'data', label: 'Export', description: '', implies: ['data.query'], danger: false, scope: 'dataset' },
  ],
};

describe('permission implications', () => {
  it('follow chains, as the control plane resolves them, each within its scope', () => {
    assert.deepEqual([...expandPermissions(['data.export'], catalog)].sort(), ['data.export', 'data.query', 'dataset.view_schema']);
    assert.deepEqual([...expandPermissions(['materializations.view_details'], catalog)].sort(), [
      'materializations.view',
      'materializations.view_details',
    ]);
  });

  it('read * as every permission and drop keys the catalog does not know', () => {
    assert.equal(expandPermissions(['*'], catalog).size, 5);
    assert.deepEqual([...expandPermissions(['nope', 'materializations.view'], catalog)], ['materializations.view']);
    assert.equal(expandPermissions(['data.query'], undefined).size, 0);
  });
});

describe('generated passwords', () => {
  it('are as long as asked, from an alphabet without lookalikes', () => {
    const password = generatePassword(20);
    assert.equal(password.length, 20);
    assert.ok([...password].every((character) => PASSWORD_ALPHABET.includes(character)));
    assert.doesNotMatch(PASSWORD_ALPHABET, /[0O1lI]/);
  });

  it('take every character from the random source', () => {
    const fixed = (values: Uint32Array): Uint32Array => values.fill(0);
    assert.equal(generatePassword(4, fixed), PASSWORD_ALPHABET[0]!.repeat(4));
  });
});

describe('describing sessions and audit details', () => {
  it('names the browser and the platform', () => {
    assert.equal(
      describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'),
      'Chrome on macOS',
    );
    assert.equal(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0'), 'Firefox on Windows');
    assert.equal(describeAgent('curl/8.7.1'), 'curl');
    assert.equal(describeAgent(null), 'Unknown browser');
  });

  it('reads changes as before and after', () => {
    assert.equal(describeDetail({ from: 'Ops', to: 'Operations' }), 'Ops → Operations');
    assert.equal(describeDetail(['Viewer', 'Editor']), 'Viewer, Editor');
    assert.equal(describeDetail({ added: ['Editor'], removed: [] }), 'added: Editor; removed: none');
    assert.equal(describeDetail(null), '—');
  });
});

describe('describeMethod', () => {
  it('says how a session was started', () => {
    assert.equal(describeMethod('password'), 'with a password');
    assert.equal(describeMethod('sso:entra'), 'through Microsoft');
    assert.equal(describeMethod('sso:github'), 'through GitHub');
    assert.equal(describeMethod('sso:oidc'), 'through single sign-on');
    assert.equal(describeMethod('sso:other'), 'through other');
  });
});

describe('audit actions', () => {
  // Every action the control plane audits (handbook 18): each reads as words on the audit page.
  const AUDITED = [
    'session.signed_in', 'session.sign_in_failed', 'session.locked_out', 'session.signed_out',
    'user.created', 'user.updated', 'user.deactivated', 'user.reactivated', 'user.deleted', 'user.password_reset',
    'user.password_changed', 'user.signed_out', 'user.session_ended', 'user.unlocked', 'user.bootstrapped',
    'user.bootstrap_restored', 'user.provisioned', 'user.identity_linked',
    'group.created', 'group.updated', 'group.deleted', 'role.created', 'role.updated', 'role.deleted',
    'dataset.created', 'dataset.updated', 'dataset.deleted', 'dataset.access_changed',
    'token.created', 'token.revoked', 'token.revocation_applied', 'directory.seeded',
  ];

  it('label every action the control plane audits', () => {
    assert.deepEqual(AUDITED.filter((action) => !(action in AUDIT_ACTION_LABELS)), []);
    assert.equal(auditActionLabel('token.revocation_applied'), 'Recorded a token revoked in another domain');
    assert.equal(auditActionLabel('dataset.access_changed'), 'Changed who may use a dataset');
  });

  it('read an action this console does not know as words, never as its code', () => {
    assert.equal(auditActionLabel('pipeline.started_again'), 'Pipeline started again');
  });
});

describe('invitations', () => {
  it('read the addresses in whatever was pasted, each once', () => {
    assert.deepEqual(
      parseEmails('Ada@Example.com, grace@example.com;\nAda Lovelace <ada@example.com>  mailto:bob@example.org\n\n'),
      { emails: ['ada@example.com', 'grace@example.com', 'bob@example.org'], invalid: [] },
    );
    assert.deepEqual(parseEmails('ada@example, @example.com, plain, ok@example.com'), {
      emails: ['ok@example.com'],
      invalid: ['ada@example', '@example.com', 'plain'],
    });
    assert.deepEqual(parseEmails('   '), { emails: [], invalid: [] });
  });

  it('carry every domain’s invitation after # in one link, and read back only what could be one', () => {
    const a = { domain: 'domain_a', token: `inv_usr-0123456789ab.${'A'.repeat(43)}` };
    const b = { domain: 'domain_b', token: `inv_usr-ba9876543210.${'B'.repeat(43)}` };
    const link = invitationLink('https://midstream.example.com/', [a, b]);
    assert.equal(link, `https://midstream.example.com/invitation#domain_a:${a.token},domain_b:${b.token}`);
    assert.deepEqual(invitationEntries(new URL(link).hash), [a, b]);
    // One per domain; anything that is not a domain's invitation is left out.
    assert.deepEqual(invitationEntries(`#domain_a:${a.token},domain_a:${b.token},Domain_C:${a.token},domain_d:inv_usr-1.short`), [a]);
    for (const hash of ['', '#', `#${a.token}`, `#tok_${'A'.repeat(43)}`, `#domain_a:${a.token}:x`, '#%E0%A4%A']) {
      assert.deepEqual(invitationEntries(hash), [], hash);
    }
  });

  it('say how invited people join, as a domain takes sign-ins', () => {
    const password = { id: 'password', type: 'password', label: 'Email and password', administrators_only: false };
    const google = { id: 'google', type: 'sso', label: 'Google' };
    const github = { id: 'github', type: 'sso', label: 'GitHub' };
    assert.deepEqual(joinWays([password, google, github]), { providers: ['Google', 'GitHub'], links: true });
    assert.deepEqual(joinWays([{ ...password, administrators_only: true }, google]), { providers: ['Google'], links: false });
    assert.deepEqual(joinWays([]), { providers: [], links: false });
    assert.equal(orList(['Microsoft', 'Google', 'GitHub']), 'Microsoft, Google or GitHub');
    assert.equal(orList(['Google']), 'Google');
    assert.equal(orList([]), '');
    assert.equal(andList(['Domain A', 'Domain B']), 'Domain A and Domain B');
    assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
  });

  it('say how people invited to several domains join, one invitation to them', () => {
    const password = { id: 'password', type: 'password', label: 'Email and password', administrators_only: false };
    const google = { id: 'google', type: 'sso', label: 'Google' };
    const github = { id: 'github', type: 'sso', label: 'GitHub' };
    const entra = { id: 'entra', type: 'sso', label: 'Microsoft' };
    const domainA = (...providers: AuthProvider[]) => ({ name: 'Domain A', providers });
    const domainB = (...providers: AuthProvider[]) => ({ name: 'Domain B', providers });

    // Only a provider every domain takes joins them all; the link joins each taking passwords.
    const both = joinWaysAcross([domainA(password, github), domainB(password, entra, github, google)]);
    assert.deepEqual(both, { providers: ['GitHub'], links: true, elsewhere: [] });
    assert.equal(joinSentence(both, 2), 'They join by signing in through GitHub with that email, or with the one link each gets here, for every domain.');
    assert.equal(
      joinSentence(joinWaysAcross([domainA(password, github), domainB(password, google)]), 2),
      'They join with the one link each gets here, for every domain, choosing their own password.',
    );
    // A domain taking no passwords gets no link: said, with how it is joined.
    const mixed = joinWaysAcross([domainA(password, github), domainB({ ...password, administrators_only: true }, entra)]);
    assert.deepEqual(mixed, { providers: [], links: true, elsewhere: [{ name: 'Domain B', providers: ['Microsoft'] }] });
    assert.equal(
      joinSentence(mixed, 2),
      'They join with the one link each gets here, choosing their own password. Domain B takes no passwords: there they sign in through Microsoft.',
    );
    // No link anywhere: a shared provider is enough; with none, each domain's own.
    assert.equal(joinSentence(joinWaysAcross([domainA(github, google), domainB(google)]), 2), 'They join by signing in through Google with that email.');
    assert.equal(
      joinSentence(joinWaysAcross([domainA(github), domainB()]), 2),
      'Domain A takes no passwords: there they sign in through GitHub. Nobody can join Domain B yet: it takes no sign-in provider, and only administrators may use a password.',
    );
    // One domain reads as before.
    assert.equal(joinSentence(joinWaysAcross([domainA(password, google)]), 1), 'They join by signing in through Google with that email, or with the link each one gets here.');
    assert.equal(joinSentence(joinWaysAcross([domainA()]), 1), 'Nobody can join yet: no sign-in provider is on, and only administrators may use a password.');
    assert.deepEqual(takenByAll([[github, google], [google, github], [entra, google]]), [google]);
    assert.deepEqual(takenByAll([]), []);
  });

  it('name what each invitation step did in the audit log', () => {
    for (const action of ['user.invited', 'user.invitation_renewed', 'user.invitation_revoked', 'user.invitation_accepted']) {
      assert.ok(AUDIT_ACTION_LABELS[action], action);
    }
  });
});

describe('refusals', () => {
  it('say which field they are about, refused by the identity agent or by the control plane itself', () => {
    assert.equal(refusalDetails({ field: 'email', reason: 'already_exists' }).field, 'email');
    const checked = refusalDetails({ upstream_code: 'already_exists', upstream_details: { field: 'email', problems: [{ index: 0 }] } });
    assert.equal(checked.field, 'email');
    assert.deepEqual(checked.problems, [{ index: 0 }]);
    assert.deepEqual(refusalDetails({}), {});
  });
});

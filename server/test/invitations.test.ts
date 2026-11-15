// Invitations: wrong links are limited per address on a counter of their own (apart from sign-ins), and the username
// offered on the invitation page.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attempt, attemptInvitation, checkRate } from '../src/auth.ts';
import { usernameFrom } from '../src/api/invitations.ts';

const from = (ip: string) => ({ socket: { remoteAddress: ip }, headers: {} }) as any;
const tooMany = (e: any) => e.status === 429;

test('wrong invitation links: ten per address, counted apart from sign-ins', () => {
  const guesser = from('203.0.113.50');
  for (let i = 0; i < 10; i++) attemptInvitation(guesser);
  assert.throws(() => attemptInvitation(guesser), tooMany);
  assert.doesNotThrow(() => checkRate(guesser, 'alice')); // signing in from that address still works
  // ...and wrong passwords do not block an invitee on the same network
  const household = from('203.0.113.51');
  for (let i = 0; i < 10; i++) attempt(household, 'bob');
  assert.throws(() => attempt(household, 'bob'), tooMany);
  assert.doesNotThrow(() => attemptInvitation(household).succeeded());
  // a link that works takes its count back
  const invitee = from('203.0.113.52');
  for (let i = 0; i < 30; i++) attemptInvitation(invitee).succeeded();
  assert.doesNotThrow(() => attemptInvitation(invitee));
});

test('suggested usernames keep only what a username may contain', () => {
  assert.equal(usernameFrom('Zoë Müller'), 'zoe.muller');
  assert.equal(usernameFrom('  Anna   Maria  '), 'anna.maria');
  assert.equal(usernameFrom('john.doe'), 'john.doe');
  assert.equal(usernameFrom("O'Brien, Seán"), 'obrien.sean');
  assert.equal(usernameFrom('...--x--...'), 'x');
  assert.equal(usernameFrom('عبد الله'), '');
  assert.equal(usernameFrom('x'.repeat(100)), 'x'.repeat(64));
  assert.match(usernameFrom('a b '.repeat(40)), /^[a-z0-9._@-]{1,64}$/);
});

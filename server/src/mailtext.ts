// The server's own text: emails (English).
// inviteName is the optional part of inviteText's greeting ({name}): filled in when the invitation names the person.
type MailKey =
  | 'open' | 'shareSubject' | 'shareFile' | 'shareFolder' | 'shareGroup'
  | 'pwSubject' | 'pwText' | 'emailSubject' | 'emailText' | 'resetSubject' | 'resetText' | 'resetAction' | 'testSubject' | 'testText'
  | 'inviteSubject' | 'inviteText' | 'inviteName' | 'inviteAction';

const MAIL: Record<MailKey, string> = {
  open: 'Open Cloudy',
  shareSubject: '{who} shared "{name}" with you',
  shareFile: 'Hi {user},\n\n{who} shared the file "{name}" with you{group}. You\'ll find it under "Shared with you".\n\nYou can turn these emails off in Cloudy under Settings → Account.',
  shareFolder: 'Hi {user},\n\n{who} shared the folder "{name}" with you{group}. You\'ll find it under "Shared with you".\n\nYou can turn these emails off in Cloudy under Settings → Account.',
  shareGroup: ' (group {group})',
  pwSubject: 'Your Cloudy password was changed',
  pwText: 'Hi {user},\n\nThe password of your Cloudy account "{id}" was just changed (from {ip}).\n\nIf this wasn\'t you, reset your password right away and tell your administrator.',
  emailSubject: 'Your Cloudy email address was changed',
  emailText: 'Hi {user},\n\nThe email address of your Cloudy account "{id}" was just changed to {email} (from {ip}). This address will no longer get password reset links.\n\nIf this wasn\'t you, sign in, change your password and tell your administrator.',
  resetSubject: 'Reset your Cloudy password',
  resetText: 'Hi {user},\n\nSomeone (hopefully you) asked to reset the password of your Cloudy account "{id}". The link works once and expires in {minutes} minutes.\n\nIf you didn\'t ask for this, ignore this email — your password stays the same.',
  resetAction: 'Choose a new password',
  testSubject: 'Cloudy test email',
  testText: 'This is a test email from your Cloudy server.\n\nEmail is set up correctly — Cloudy can send password reset links and notifications.',
  inviteSubject: '{who} invited you to Cloudy',
  inviteText: 'Hi{name},\n\n{who} invited you to Cloudy, a private cloud for your files. Choose your username and password to create your account.\n\nThe link works once and expires in {days} days. If you didn\'t expect this invitation, ignore this email.',
  inviteName: ' {name}',
  inviteAction: 'Create your account',
};

/** Email text with {placeholders} filled in. */
export function mailText(key: MailKey, vars: Record<string, string | number> = {}): string {
  return MAIL[key].replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

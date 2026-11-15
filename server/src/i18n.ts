// Languages: the list users can pick from (web + Android), and the server's own text — emails.
// The web app's strings live in public/i18n/<lang>.json, Android's in res/values-<lang>/strings.xml.
import type { IncomingMessage } from 'node:http';

export const LANGUAGES = ['en', 'ar', 'de', 'fr', 'es'] as const;
export type Lang = (typeof LANGUAGES)[number];

export const isLanguage = (v: unknown): v is Lang => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
export const isRtl = (lang: Lang) => lang === 'ar';

/** The user's saved language, else the best match from the request's Accept-Language, else English. */
export function pickLanguage(saved: string | null | undefined, req?: IncomingMessage): Lang {
  if (isLanguage(saved)) return saved;
  for (const part of String(req?.headers['accept-language'] ?? '').split(',')) {
    const code = part.trim().split(/[-;_]/)[0].toLowerCase();
    if (isLanguage(code)) return code;
  }
  return 'en';
}

// inviteName is the optional part of inviteText's greeting ({name}): filled in when the invitation names the person.
type MailKey =
  | 'open' | 'shareSubject' | 'shareFile' | 'shareFolder' | 'shareGroup'
  | 'pwSubject' | 'pwText' | 'emailSubject' | 'emailText' | 'resetSubject' | 'resetText' | 'resetAction' | 'testSubject' | 'testText'
  | 'inviteSubject' | 'inviteText' | 'inviteName' | 'inviteAction';

const MAIL: Record<Lang, Record<MailKey, string>> = {
  en: {
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
    inviteText: 'Hi{name},\n\n{who} invited you to Cloudy, a private cloud for your files, calendars and contacts. Choose your username and password to create your account.\n\nThe link works once and expires in {days} days. If you didn\'t expect this invitation, ignore this email.',
    inviteName: ' {name}',
    inviteAction: 'Create your account',
  },
  ar: {
    open: 'فتح Cloudy',
    shareSubject: 'شارك {who} «{name}» معك',
    shareFile: 'مرحبًا {user}،\n\nشارك {who} الملف «{name}» معك{group}. ستجده ضمن «تمت مشاركتها معك».\n\nيمكنك إيقاف هذه الرسائل في Cloudy من الإعدادات ← الحساب.',
    shareFolder: 'مرحبًا {user}،\n\nشارك {who} المجلد «{name}» معك{group}. ستجده ضمن «تمت مشاركتها معك».\n\nيمكنك إيقاف هذه الرسائل في Cloudy من الإعدادات ← الحساب.',
    shareGroup: ' (المجموعة {group})',
    pwSubject: 'تم تغيير كلمة مرور Cloudy الخاصة بك',
    pwText: 'مرحبًا {user}،\n\nتم للتو تغيير كلمة مرور حسابك «{id}» في Cloudy (من {ip}).\n\nإذا لم تكن أنت من فعل ذلك، فأعد تعيين كلمة المرور فورًا وأبلغ المسؤول.',
    emailSubject: 'تم تغيير عنوان بريدك الإلكتروني في Cloudy',
    emailText: 'مرحبًا {user}،\n\nتم للتو تغيير عنوان البريد الإلكتروني لحسابك «{id}» في Cloudy إلى {email} (من {ip}). لن تصل روابط إعادة تعيين كلمة المرور إلى هذا العنوان بعد الآن.\n\nإذا لم تكن أنت من فعل ذلك، فسجّل الدخول وغيّر كلمة المرور وأبلغ المسؤول.',
    resetSubject: 'إعادة تعيين كلمة مرور Cloudy',
    resetText: 'مرحبًا {user}،\n\nطلب شخص ما (نأمل أن تكون أنت) إعادة تعيين كلمة مرور حسابك «{id}» في Cloudy. يعمل الرابط مرة واحدة وتنتهي صلاحيته خلال {minutes} دقيقة.\n\nإذا لم تطلب ذلك، فتجاهل هذه الرسالة — ستبقى كلمة المرور كما هي.',
    resetAction: 'اختيار كلمة مرور جديدة',
    testSubject: 'رسالة تجريبية من Cloudy',
    testText: 'هذه رسالة تجريبية من خادم Cloudy.\n\nتم إعداد البريد الإلكتروني بشكل صحيح — يستطيع Cloudy إرسال روابط إعادة تعيين كلمة المرور والإشعارات.',
    inviteSubject: 'دعاك {who} إلى Cloudy',
    inviteText: 'مرحبًا{name}،\n\nدعاك {who} إلى Cloudy، وهي سحابة خاصة لملفاتك وتقاويمك وجهات اتصالك. اختر اسم المستخدم وكلمة المرور لإنشاء حسابك.\n\nيعمل الرابط مرة واحدة وتنتهي صلاحيته خلال {days} أيام. إذا لم تكن تتوقع هذه الدعوة، فتجاهل هذه الرسالة.',
    inviteName: ' {name}',
    inviteAction: 'إنشاء حسابك',
  },
  de: {
    open: 'Cloudy öffnen',
    shareSubject: '{who} hat „{name}“ mit dir geteilt',
    shareFile: 'Hallo {user},\n\n{who} hat die Datei „{name}“ mit dir geteilt{group}. Du findest sie unter „Mit dir geteilt“.\n\nDiese E-Mails kannst du in Cloudy unter Einstellungen → Konto abschalten.',
    shareFolder: 'Hallo {user},\n\n{who} hat den Ordner „{name}“ mit dir geteilt{group}. Du findest ihn unter „Mit dir geteilt“.\n\nDiese E-Mails kannst du in Cloudy unter Einstellungen → Konto abschalten.',
    shareGroup: ' (Gruppe {group})',
    pwSubject: 'Dein Cloudy-Passwort wurde geändert',
    pwText: 'Hallo {user},\n\ndas Passwort deines Cloudy-Kontos „{id}“ wurde soeben geändert (von {ip}).\n\nWarst du das nicht, setze dein Passwort sofort zurück und informiere deine Administration.',
    emailSubject: 'Deine Cloudy-E-Mail-Adresse wurde geändert',
    emailText: 'Hallo {user},\n\ndie E-Mail-Adresse deines Cloudy-Kontos „{id}“ wurde soeben auf {email} geändert (von {ip}). An diese Adresse gehen keine Links zum Zurücksetzen des Passworts mehr.\n\nWarst du das nicht, melde dich an, ändere dein Passwort und informiere deine Administration.',
    resetSubject: 'Cloudy-Passwort zurücksetzen',
    resetText: 'Hallo {user},\n\njemand (hoffentlich du) möchte das Passwort deines Cloudy-Kontos „{id}“ zurücksetzen. Der Link funktioniert einmal und läuft in {minutes} Minuten ab.\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail – dein Passwort bleibt unverändert.',
    resetAction: 'Neues Passwort wählen',
    testSubject: 'Cloudy-Test-E-Mail',
    testText: 'Dies ist eine Test-E-Mail deines Cloudy-Servers.\n\nE-Mail ist richtig eingerichtet – Cloudy kann Links zum Zurücksetzen von Passwörtern und Benachrichtigungen senden.',
    inviteSubject: '{who} hat dich zu Cloudy eingeladen',
    inviteText: 'Hallo{name},\n\n{who} hat dich zu Cloudy eingeladen, einer privaten Cloud für deine Dateien, Kalender und Kontakte. Wähle deinen Benutzernamen und dein Passwort, um dein Konto zu erstellen.\n\nDer Link funktioniert einmal und läuft in {days} Tagen ab. Wenn du diese Einladung nicht erwartet hast, ignoriere diese E-Mail.',
    inviteName: ' {name}',
    inviteAction: 'Konto erstellen',
  },
  fr: {
    open: 'Ouvrir Cloudy',
    shareSubject: '{who} a partagé « {name} » avec vous',
    shareFile: 'Bonjour {user},\n\n{who} a partagé le fichier « {name} » avec vous{group}. Vous le trouverez dans « Partagés avec vous ».\n\nVous pouvez désactiver ces e-mails dans Cloudy sous Paramètres → Compte.',
    shareFolder: 'Bonjour {user},\n\n{who} a partagé le dossier « {name} » avec vous{group}. Vous le trouverez dans « Partagés avec vous ».\n\nVous pouvez désactiver ces e-mails dans Cloudy sous Paramètres → Compte.',
    shareGroup: ' (groupe {group})',
    pwSubject: 'Votre mot de passe Cloudy a été modifié',
    pwText: 'Bonjour {user},\n\nLe mot de passe de votre compte Cloudy « {id} » vient d’être modifié (depuis {ip}).\n\nSi ce n’était pas vous, réinitialisez votre mot de passe immédiatement et prévenez votre administrateur.',
    emailSubject: 'Votre adresse e-mail Cloudy a été modifiée',
    emailText: 'Bonjour {user},\n\nL’adresse e-mail de votre compte Cloudy « {id} » vient d’être remplacée par {email} (depuis {ip}). Cette adresse ne recevra plus les liens de réinitialisation du mot de passe.\n\nSi ce n’était pas vous, connectez-vous, changez votre mot de passe et prévenez votre administrateur.',
    resetSubject: 'Réinitialiser votre mot de passe Cloudy',
    resetText: 'Bonjour {user},\n\nQuelqu’un (vous, espérons-le) a demandé à réinitialiser le mot de passe de votre compte Cloudy « {id} ». Le lien fonctionne une seule fois et expire dans {minutes} minutes.\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail — votre mot de passe reste inchangé.',
    resetAction: 'Choisir un nouveau mot de passe',
    testSubject: 'E-mail de test Cloudy',
    testText: 'Ceci est un e-mail de test de votre serveur Cloudy.\n\nL’e-mail est correctement configuré — Cloudy peut envoyer des liens de réinitialisation de mot de passe et des notifications.',
    inviteSubject: '{who} vous invite à rejoindre Cloudy',
    inviteText: 'Bonjour{name},\n\n{who} vous invite à rejoindre Cloudy, un cloud privé pour vos fichiers, agendas et contacts. Choisissez votre nom d’utilisateur et votre mot de passe pour créer votre compte.\n\nLe lien fonctionne une seule fois et expire dans {days} jours. Si vous ne vous attendiez pas à cette invitation, ignorez cet e-mail.',
    inviteName: ' {name}',
    inviteAction: 'Créer votre compte',
  },
  es: {
    open: 'Abrir Cloudy',
    shareSubject: '{who} ha compartido «{name}» contigo',
    shareFile: 'Hola, {user}:\n\n{who} ha compartido el archivo «{name}» contigo{group}. Lo encontrarás en «Compartidos contigo».\n\nPuedes desactivar estos correos en Cloudy, en Ajustes → Cuenta.',
    shareFolder: 'Hola, {user}:\n\n{who} ha compartido la carpeta «{name}» contigo{group}. La encontrarás en «Compartidos contigo».\n\nPuedes desactivar estos correos en Cloudy, en Ajustes → Cuenta.',
    shareGroup: ' (grupo {group})',
    pwSubject: 'Se ha cambiado tu contraseña de Cloudy',
    pwText: 'Hola, {user}:\n\nSe acaba de cambiar la contraseña de tu cuenta de Cloudy «{id}» (desde {ip}).\n\nSi no has sido tú, restablece tu contraseña de inmediato y avisa a tu administrador.',
    emailSubject: 'Se ha cambiado tu dirección de correo de Cloudy',
    emailText: 'Hola, {user}:\n\nSe acaba de cambiar la dirección de correo de tu cuenta de Cloudy «{id}» a {email} (desde {ip}). Esta dirección ya no recibirá enlaces para restablecer la contraseña.\n\nSi no has sido tú, inicia sesión, cambia tu contraseña y avisa a tu administrador.',
    resetSubject: 'Restablece tu contraseña de Cloudy',
    resetText: 'Hola, {user}:\n\nAlguien (esperamos que tú) ha pedido restablecer la contraseña de tu cuenta de Cloudy «{id}». El enlace funciona una sola vez y caduca en {minutes} minutos.\n\nSi no lo has pedido tú, ignora este correo: tu contraseña seguirá siendo la misma.',
    resetAction: 'Elegir una contraseña nueva',
    testSubject: 'Correo de prueba de Cloudy',
    testText: 'Este es un correo de prueba de tu servidor Cloudy.\n\nEl correo está bien configurado: Cloudy puede enviar enlaces para restablecer contraseñas y notificaciones.',
    inviteSubject: '{who} te ha invitado a Cloudy',
    inviteText: 'Hola{name}:\n\n{who} te ha invitado a Cloudy, una nube privada para tus archivos, calendarios y contactos. Elige tu nombre de usuario y tu contraseña para crear tu cuenta.\n\nEl enlace funciona una sola vez y caduca en {days} días. Si no esperabas esta invitación, ignora este correo.',
    inviteName: ', {name}',
    inviteAction: 'Crear tu cuenta',
  },
};

/** Email text in `lang`, with {placeholders} filled in. */
export function mailText(lang: Lang, key: MailKey, vars: Record<string, string | number> = {}): string {
  return MAIL[lang][key].replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

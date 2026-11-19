// Cloudy's sync badges in Dolphin (KDE): a green tick on synced items, blue arrows while they sync, a red mark on
// items that could not be synced. Dolphin asks every overlay plugin about each item it shows (getOverlays, which must
// answer at once): this one answers from what the Cloudy app said, asks the app about the rest over a loopback
// connection, and announces the answer (overlaysChanged). The app writes its port and two random values to
// ~/.config/Cloudy/finder.json; protocol and the two proofs: see desktop/src/main/finder.ts. When Cloudy is not
// running there are no badges. Pictures: the emblem-cloudy-* icons the app puts into ~/.local/share/icons/hicolor.
#include <KOverlayIconPlugin>

#include <QDir>
#include <QFile>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QStandardPaths>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>

namespace {

/** One link to the app per Dolphin process, shared by the plugin of every view (each view loads its own). */
class Connection : public QObject {
  Q_OBJECT
 public:
  static Connection *get() {
    static Connection *c = new Connection(); // lives as long as Dolphin
    return c;
  }

  QStringList overlays(const QUrl &url) {
    if (!url.isLocalFile() || !m_verified) return {};
    const QString path = url.toLocalFile();
    if (!under(path)) return {};
    if (m_badges.contains(path)) return emblem(m_badges.value(path));
    if (m_known.size() >= 50000) { m_known.clear(); m_badges.clear(); }
    m_known.insert(path);
    ask({path});
    return {};
  }

 Q_SIGNALS:
  void changed(const QUrl &url, const QStringList &overlays);

 private:
  QTcpSocket m_sock;
  QByteArray m_in;
  QString m_app, m_secret;
  bool m_verified = false;
  QStringList m_folders;
  QHash<QString, QString> m_badges; // path -> "synced" | "syncing" | "error" | "" (answered)
  QSet<QString> m_known;            // paths Dolphin asked about (asked again when the app says they changed)
  QSet<QString> m_waiting;
  QTimer m_flush, m_retry, m_proof;

  Connection() {
    m_flush.setSingleShot(true);
    m_flush.setInterval(50);
    connect(&m_flush, &QTimer::timeout, this, &Connection::flush);
    m_retry.setSingleShot(true);
    m_retry.setInterval(3000);
    connect(&m_retry, &QTimer::timeout, this, &Connection::open);
    // Cloudy says who it is at once; something else that took over a stale port gets 10 seconds.
    m_proof.setSingleShot(true);
    m_proof.setInterval(10000);
    connect(&m_proof, &QTimer::timeout, this, [this] { if (!m_verified) lost(); });
    connect(&m_sock, &QTcpSocket::readyRead, this, &Connection::readable);
    connect(&m_sock, &QTcpSocket::disconnected, this, &Connection::lost);
    connect(&m_sock, &QTcpSocket::errorOccurred, this, &Connection::lost);
    QTimer::singleShot(0, this, &Connection::open);
  }

  static QStringList emblem(const QString &badge) {
    if (badge == QLatin1String("synced") || badge == QLatin1String("syncing") || badge == QLatin1String("error"))
      return {QStringLiteral("emblem-cloudy-") + badge};
    return {};
  }

  bool under(const QString &path) const {
    for (const QString &f : m_folders) {
      if (path == f || path.startsWith(f.endsWith(QLatin1Char('/')) ? f : f + QLatin1Char('/'))) return true;
    }
    return false;
  }

  static QString portFile() {
    const QByteArray test = qgetenv("CLOUDY_BADGES_FILE");
    if (!test.isEmpty()) return QString::fromLocal8Bit(test);
    QString config = QString::fromLocal8Bit(qgetenv("XDG_CONFIG_HOME"));
    if (config.isEmpty()) config = QDir::homePath() + QStringLiteral("/.config");
    return config + QStringLiteral("/Cloudy/finder.json");
  }

  void open() {
    if (m_sock.state() != QAbstractSocket::UnconnectedState) return;
    QFile f(portFile());
    if (!f.open(QIODevice::ReadOnly)) { m_retry.start(); return; }
    const QJsonObject o = QJsonDocument::fromJson(f.read(4096)).object();
    const int port = o.value(QStringLiteral("port")).toInt();
    m_secret = o.value(QStringLiteral("secret")).toString();
    m_app = o.value(QStringLiteral("app")).toString();
    if (port <= 0 || port > 65535 || m_secret.isEmpty() || m_app.isEmpty()) { m_retry.start(); return; }
    m_in.clear();
    m_verified = false;
    m_sock.connectToHost(QStringLiteral("127.0.0.1"), quint16(port));
    m_proof.start();
  }

  /** Cloudy quit (or was never there): no folders, no badges that could be wrong. */
  void lost() {
    if (m_retry.isActive()) return;
    m_proof.stop();
    const bool had = m_verified;
    m_verified = false;
    m_folders.clear();
    m_badges.clear();
    m_waiting.clear();
    m_sock.abort();
    if (had) for (const QString &p : std::as_const(m_known)) Q_EMIT changed(QUrl::fromLocalFile(p), {});
    m_retry.start();
  }

  void send(const QJsonObject &o) {
    m_sock.write(QJsonDocument(o).toJson(QJsonDocument::Compact) + '\n');
  }

  void readable() {
    m_in += m_sock.readAll();
    if (m_in.size() > (m_verified ? 16 * 1024 * 1024 : 512)) return lost(); // the app's first line is short
    int nl;
    while ((nl = m_in.indexOf('\n')) >= 0) {
      const QByteArray line = m_in.left(nl);
      m_in.remove(0, nl + 1);
      const QJsonDocument doc = QJsonDocument::fromJson(line);
      if (doc.isObject() && !handle(doc.object())) return lost();
    }
  }

  bool handle(const QJsonObject &msg) {
    if (!m_verified) {
      // The app proves first that it read finder.json (else this is someone else on that port: say nothing).
      if (msg.value(QStringLiteral("app")).toString() != m_app) return false;
      m_verified = true;
      send({{QStringLiteral("hello"), m_secret}});
      return true;
    }
    if (msg.value(QStringLiteral("folders")).isArray()) {
      m_folders.clear();
      for (const QJsonValue &v : msg.value(QStringLiteral("folders")).toArray()) if (v.isString()) m_folders << v.toString();
      // Items no longer in a sync folder lose their badge; the others are asked again.
      for (auto it = m_badges.cbegin(); it != m_badges.cend(); ++it) {
        if (!it.value().isEmpty() && !under(it.key())) Q_EMIT changed(QUrl::fromLocalFile(it.key()), {});
      }
      m_badges.clear();
      ask(QStringList(m_known.cbegin(), m_known.cend()));
    }
    if (msg.value(QStringLiteral("badges")).isObject()) {
      const QJsonObject b = msg.value(QStringLiteral("badges")).toObject();
      for (auto it = b.begin(); it != b.end(); ++it) {
        if (!it.value().isString()) continue;
        const QString badge = it.value().toString();
        const bool had = m_badges.contains(it.key());
        if (had && m_badges.value(it.key()) == badge) continue;
        m_badges.insert(it.key(), badge);
        if (had || !badge.isEmpty()) Q_EMIT changed(QUrl::fromLocalFile(it.key()), emblem(badge));
      }
    }
    if (msg.contains(QStringLiteral("changed"))) {
      // Ask again; the old badge stays until the answer.
      const QJsonValue c = msg.value(QStringLiteral("changed"));
      if (c.isArray()) {
        QStringList again;
        for (const QJsonValue &v : c.toArray()) if (m_known.contains(v.toString())) again << v.toString();
        ask(again);
      } else if (c.isNull()) {
        ask(QStringList(m_known.cbegin(), m_known.cend()));
      }
    }
    return true;
  }

  void ask(const QStringList &paths) {
    for (const QString &p : paths) m_waiting.insert(p);
    if (!m_waiting.isEmpty() && !m_flush.isActive()) m_flush.start();
  }

  void flush() {
    if (!m_verified || m_waiting.isEmpty()) return;
    const QStringList all(m_waiting.cbegin(), m_waiting.cend());
    m_waiting.clear();
    for (int i = 0; i < all.size(); i += 1000) { // the app reads lines up to a limit
      QJsonArray part;
      for (const QString &p : all.mid(i, 1000)) part.append(p);
      send({{QStringLiteral("ask"), part}});
    }
  }
};

}  // namespace

class CloudyOverlay : public KOverlayIconPlugin {
  Q_OBJECT
  Q_PLUGIN_METADATA(IID "org.kde.overlayicon.cloudy" FILE "cloudyoverlay.json")
 public:
  explicit CloudyOverlay(QObject *parent = nullptr) : KOverlayIconPlugin(parent) {
    connect(Connection::get(), &Connection::changed, this, &KOverlayIconPlugin::overlaysChanged);
  }
  QStringList getOverlays(const QUrl &item) override { return Connection::get()->overlays(item); }
};

#include "cloudyoverlay.moc"

import FileProvider

/// Lists one folder when the Files app opens it. All changes go through the working set: the app signals it on live
/// events, and `Remote.changes()` reports updates and deletions for every folder the Files app has listed.
final class Enumerator: NSObject, NSFileProviderEnumerator {
    private let container: NSFileProviderItemIdentifier

    init(_ container: NSFileProviderItemIdentifier) { self.container = container }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        if container == .workingSet { // folders are listed on demand; changes come in enumerateChanges
            observer.finishEnumerating(upTo: nil)
            return
        }
        Task {
            do {
                try await Account.ready()
                observer.didEnumerate(try await Remote.list(container))
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(providerError(error))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        guard Index.shared.isCurrent(anchor.rawValue) else {
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
        guard container == .workingSet else { // all changes are reported through the working set
            observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Index.shared.anchor), moreComing: false)
            return
        }
        Task {
            do {
                try await Account.ready()
                let (updated, deleted) = try await Remote.changes()
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted) }
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Index.shared.bump()), moreComing: false)
            } catch {
                observer.finishEnumeratingWithError(providerError(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Index.shared.anchor))
    }
}

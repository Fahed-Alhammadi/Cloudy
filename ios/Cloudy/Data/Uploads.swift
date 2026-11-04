import Foundation
import Observation
import UIKit

/// Uploads in progress, shown at the top of the folder they go to. Each one asks iOS for background
/// time so a short upload finishes after the user leaves the app.
@Observable
final class Uploads {
    static let shared = Uploads()

    struct Job: Identifiable {
        let id = UUID()
        let name: String
        let parentId: Int64
        var sent: Int64 = 0
        var total: Int64 = 0
        var error: String?
        var fraction: Double { total > 0 ? Double(sent) / Double(total) : 0 }
    }

    private(set) var jobs: [Job] = []
    private var tasks: [UUID: Task<Void, Never>] = [:]

    func jobs(in folder: Int64) -> [Job] { jobs.filter { $0.parentId == folder } }

    /// Uploads `file` (a local copy this class may delete afterwards) into `parentId`.
    @MainActor
    func start(_ file: URL, name: String, parentId: Int64, deleteAfter: Bool = true) {
        let job = Job(name: name, parentId: parentId)
        jobs.append(job)
        let bg = BackgroundTask()
        bg.id = UIApplication.shared.beginBackgroundTask(withName: "upload") { bg.end() }
        tasks[job.id] = Task {
            do {
                try await API.shared.upload(parentId, name: name, file: file) { sent, total in
                    DispatchQueue.main.async { self.update(job.id) { $0.sent = sent; $0.total = total } }
                }
                jobs.removeAll { $0.id == job.id }
                NotificationCenter.default.post(name: .cloudyChange, object: ChangeEvent(folders: [parentId]))
            } catch is CancellationError {
                jobs.removeAll { $0.id == job.id } // cancelled by the user
            } catch let e as URLError where e.code == .cancelled {
                jobs.removeAll { $0.id == job.id }
            } catch {
                update(job.id) { $0.error = errorText(error) }
            }
            tasks[job.id] = nil
            if deleteAfter { try? FileManager.default.removeItem(at: file) }
            bg.end()
        }
    }

    /// Removes a failed upload from the list, or stops one that is still running.
    @MainActor
    func dismiss(_ id: UUID) {
        if let task = tasks[id] { task.cancel() } else { jobs.removeAll { $0.id == id } }
    }

    private func update(_ id: UUID, _ change: (inout Job) -> Void) {
        if let i = jobs.firstIndex(where: { $0.id == id }) { change(&jobs[i]) }
    }
}

/// Background time for one upload; ended once, either when the upload is over or when iOS's time runs out.
private final class BackgroundTask: @unchecked Sendable {
    var id = UIBackgroundTaskIdentifier.invalid

    /// Called on the main thread (the expiration handler and the upload task both run there); iOS needs the
    /// expiration handler to end the task before it returns.
    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

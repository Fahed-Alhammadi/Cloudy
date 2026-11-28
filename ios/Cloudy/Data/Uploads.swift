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
    /// Counts up each time the last running upload finished well (the app answers with a haptic: one per batch, not per file).
    private(set) var finished = 0
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var quiet: Task<Void, Never>?
    /// At most this many uploads send at once; the others wait their turn in the list. Every picked item used to
    /// start at once: 150 photos were 150 uploads, each holding a chunk of up to 8 MiB in memory and sharing the
    /// connection until requests timed out.
    private static let limit = 2
    private var running = 0
    private var waiting: [(id: UUID, go: CheckedContinuation<Bool, Never>)] = []

    /// Waits for a free slot. False: the upload was dismissed while it waited (it holds no slot).
    @MainActor
    private func turn(_ id: UUID) async -> Bool {
        if running < Self.limit { running += 1; return true }
        return await withCheckedContinuation { waiting.append((id, $0)) }
    }

    /// Gives the slot to the next waiting upload, or frees it.
    @MainActor
    private func release() {
        if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().go.resume(returning: true) }
    }

    /// Counts a batch as finished once nothing has been uploading for a moment: the photos of one pick start one
    /// after the other (each after its export), so "no upload running" alone can be true between two of them.
    @MainActor
    private func batchMayBeDone() {
        quiet?.cancel()
        quiet = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            if !Task.isCancelled, !jobs.contains(where: { $0.error == nil }) { finished += 1 }
        }
    }

    func jobs(in folder: Int64) -> [Job] { jobs.filter { $0.parentId == folder } }

    /// Uploads `file` (a local copy this class may delete afterwards) into `parentId`.
    @MainActor
    func start(_ file: URL, name: String, parentId: Int64, deleteAfter: Bool = true) {
        let job = Job(name: name, parentId: parentId)
        jobs.append(job)
        let bg = BackgroundTask()
        bg.id = UIApplication.shared.beginBackgroundTask(withName: "upload") { bg.end() }
        tasks[job.id] = Task {
            let slot = await turn(job.id)
            do {
                guard slot else { throw CancellationError() }
                // keepBoth: a file that already has this name stays; the upload used to replace it without a question.
                try await API.shared.upload(parentId, name: name, file: file, keepBoth: true) { sent, total in
                    DispatchQueue.main.async { self.update(job.id) { $0.sent = sent; $0.total = total } }
                }
                jobs.removeAll { $0.id == job.id }
                batchMayBeDone()
                NotificationCenter.default.post(name: .cloudyChange, object: ChangeEvent(folders: [parentId]))
            } catch is CancellationError {
                jobs.removeAll { $0.id == job.id } // cancelled by the user
            } catch let e as URLError where e.code == .cancelled {
                jobs.removeAll { $0.id == job.id }
            } catch {
                update(job.id) { $0.error = errorText(error) }
            }
            if slot { release() }
            tasks[job.id] = nil
            if deleteAfter { try? FileManager.default.removeItem(at: file) }
            bg.end()
        }
    }

    /// Removes a failed upload from the list, or stops one that is still running.
    @MainActor
    func dismiss(_ id: UUID) {
        guard let task = tasks[id] else { jobs.removeAll { $0.id == id }; return }
        task.cancel()
        // Still waiting for its turn: let it end now, without a slot.
        if let i = waiting.firstIndex(where: { $0.id == id }) { waiting.remove(at: i).go.resume(returning: false) }
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

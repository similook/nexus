#if NEXUS_B03
    import Foundation
    import Nexus // Nexus.xcframework (gomobile): NexuscoreGoMemoryBytes
    import os

    /// bench/B-03 stage 2 (device): the extension's memory, once a second, while the tunnel runs.
    ///
    /// Compiled ONLY into builds that define NEXUS_B03. A timer that wakes the extension every
    /// second is exactly what the battery policy forbids, so a release build must not have it.
    ///
    /// One line per sample, appended to TunnelOptions.memoryLogURL:
    ///   "<unix ms> <os_proc_available_memory bytes> <go-held bytes>"
    /// Go-held is nexuscore.GoMemoryBytes (core/nexuscore/memory.go): what the Go runtime has
    /// mapped minus what it has released, i.e. its share of the extension's footprint.
    ///
    /// Bounded: never more than `maxLines` (2 h at 1 Hz). When the file reaches it, the oldest
    /// lines are dropped down to `trimTo` in one rewrite, so the file is rewritten about every
    /// 10 minutes rather than every second.
    final class MemorySampler {
        private static let maxLines = 7200
        private static let trimTo = 6600

        private let url: URL
        private let queue = DispatchQueue(label: "io.nexus.app.tunnel.b03", qos: .utility)
        private var timer: DispatchSourceTimer?
        private var handle: FileHandle?
        private var lines = 0

        init(url: URL) {
            self.url = url
        }

        func start() {
            queue.async { [self] in
                guard timer == nil else { return }
                if !FileManager.default.fileExists(atPath: url.path) {
                    FileManager.default.createFile(atPath: url.path, contents: nil)
                }
                lines = countLines()
                openForAppend()

                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now(), repeating: .seconds(1), leeway: .milliseconds(200))
                timer.setEventHandler { [weak self] in self?.sample() }
                timer.resume()
                self.timer = timer
            }
        }

        func stop() {
            queue.sync {
                timer?.cancel()
                timer = nil
                try? handle?.close()
                handle = nil
            }
        }

        private func sample() {
            if lines >= Self.maxLines { trim() }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let available = os_proc_available_memory()
            // runtime/metrics read: cheap, no stop-the-world (memory.go). Once a second, never on
            // the packet path.
            let goHeld = NexuscoreGoMemoryBytes()
            let line = "\(now) \(available) \(goHeld)\n"
            do {
                try handle?.write(contentsOf: Data(line.utf8))
                lines += 1
            } catch {
                // The container is full or gone: stop sampling rather than retry every second.
                timer?.cancel()
                timer = nil
            }
        }

        private func countLines() -> Int {
            guard let data = try? Data(contentsOf: url) else { return 0 }
            return data.reduce(0) { $1 == UInt8(ascii: "\n") ? $0 + 1 : $0 }
        }

        private func openForAppend() {
            handle = try? FileHandle(forWritingTo: url)
            _ = try? handle?.seekToEnd()
        }

        /// Keeps the newest `trimTo` lines, rewritten atomically.
        private func trim() {
            try? handle?.close()
            handle = nil
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                let kept = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(Self.trimTo)
                let body = kept.joined(separator: "\n") + (kept.isEmpty ? "" : "\n")
                try? Data(body.utf8).write(to: url, options: .atomic)
                lines = kept.count
            } else {
                try? Data().write(to: url, options: .atomic)
                lines = 0
            }
            openForAppend()
        }
    }
#endif

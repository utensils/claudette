import AVFoundation
import Darwin
import Foundation
import Speech

private let statusReady: Int32 = 0
private let statusNeedsMicrophonePermission: Int32 = 1
private let statusNeedsSpeechPermission: Int32 = 2
private let statusEngineUnavailable: Int32 = 3
private let statusUnavailable: Int32 = 4
private let statusNeedsAssets: Int32 = 5

private let engineNone: Int32 = 0
private let engineSpeechAnalyzer: Int32 = 1
private let engineSFSpeech: Int32 = 2

public struct ClaudettePlatformSpeechStatus {
    public var code: Int32
    public var engine: Int32
    public var message: UnsafeMutablePointer<CChar>?
}

public struct ClaudettePlatformSpeechTranscription {
    public var code: Int32
    public var engine: Int32
    public var text: UnsafeMutablePointer<CChar>?
    public var message: UnsafeMutablePointer<CChar>?
}

@_cdecl("claudette_platform_speech_status")
public func claudette_platform_speech_status(
    _ code: UnsafeMutablePointer<Int32>?,
    _ engine: UnsafeMutablePointer<Int32>?,
    _ message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) {
    writeStatus(platformSpeechStatus(prepare: false), code, engine, message)
}

@_cdecl("claudette_platform_speech_prepare")
public func claudette_platform_speech_prepare(
    _ code: UnsafeMutablePointer<Int32>?,
    _ engine: UnsafeMutablePointer<Int32>?,
    _ message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) {
    writeStatus(platformSpeechStatus(prepare: true), code, engine, message)
}

@_cdecl("claudette_platform_speech_transcribe_file")
public func claudette_platform_speech_transcribe_file(
    _ pathPointer: UnsafePointer<CChar>?,
    _ code: UnsafeMutablePointer<Int32>?,
    _ engine: UnsafeMutablePointer<Int32>?,
    _ text: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) {
    guard let pathPointer else {
        writeTranscription(transcriptionError(
            statusUnavailable,
            engineNone,
            "Missing audio file path for platform speech transcription."
        ), code, engine, text, message)
        return
    }

    let path = String(cString: pathPointer)
    let url = URL(fileURLWithPath: path)
    let status = platformSpeechStatus(prepare: true)
    guard status.code == statusReady else {
        writeTranscription(ClaudettePlatformSpeechTranscription(
            code: status.code,
            engine: status.engine,
            text: nil,
            message: status.message
        ), code, engine, text, message)
        return
    }
    claudette_platform_speech_free_string(status.message)

    if status.engine == engineSpeechAnalyzer {
        if #available(macOS 26.0, *) {
            let result = waitForAsync {
                do {
                    let text = try await transcribeWithSpeechAnalyzer(url: url)
                    return transcriptionSuccess(engineSpeechAnalyzer, text)
                } catch {
                    return transcriptionError(
                        statusEngineUnavailable,
                        engineSpeechAnalyzer,
                        "Apple SpeechAnalyzer transcription failed: \(error.localizedDescription)"
                    )
                }
            }
            writeTranscription(result, code, engine, text, message)
            return
        }
    }

    writeTranscription(transcribeWithSFSpeech(url: url), code, engine, text, message)
}

@_cdecl("claudette_platform_speech_free_string")
public func claudette_platform_speech_free_string(_ pointer: UnsafeMutablePointer<CChar>?) {
    if let pointer {
        free(pointer)
    }
}

private func platformSpeechStatus(prepare: Bool) -> ClaudettePlatformSpeechStatus {
    if let tccPreflightFailure = tccPreflightFailureMessage() {
        return status(
            statusEngineUnavailable,
            engineNone,
            tccPreflightFailure
        )
    }

    let microphoneStatus = microphoneAuthorizationStatus(prepare: prepare)
    if microphoneStatus != .authorized {
        return status(
            statusNeedsMicrophonePermission,
            engineNone,
            microphonePermissionMessage(microphoneStatus)
        )
    }

    let speechStatus = speechAuthorizationStatus(prepare: prepare)
    if speechStatus != .authorized {
        return status(
            statusNeedsSpeechPermission,
            engineNone,
            speechPermissionMessage(speechStatus)
        )
    }

    if #available(macOS 26.0, *) {
        let analyzerStatus = waitForAsync {
            await speechAnalyzerStatus(prepare: prepare)
        }
        if analyzerStatus.engine == engineSpeechAnalyzer {
            return analyzerStatus
        }
    }

    return sfSpeechStatus()
}

private func tccPreflightFailureMessage() -> String? {
    let bundle = Bundle.main
    if bundle.bundleURL.pathExtension.lowercased() != "app" {
        return "Apple Speech permissions require Claudette to run from a macOS .app bundle. Start Claudette with the dev helper or a packaged build."
    }

    let infoDictionary = bundle.infoDictionary ?? [:]
    if usageDescriptionValue("NSMicrophoneUsageDescription", in: infoDictionary) == nil {
        return "App bundle is missing NSMicrophoneUsageDescription. Rebuild Claudette so macOS can show the required privacy prompt."
    }
    if usageDescriptionValue("NSSpeechRecognitionUsageDescription", in: infoDictionary) == nil {
        return "App bundle is missing NSSpeechRecognitionUsageDescription. Rebuild Claudette so macOS can show the required privacy prompt."
    }
    return nil
}

private func usageDescriptionValue(
    _ key: String,
    in infoDictionary: [String: Any]
) -> String? {
    guard let value = infoDictionary[key] as? String else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func microphoneAuthorizationStatus(prepare: Bool) -> AVAuthorizationStatus {
    let current = AVCaptureDevice.authorizationStatus(for: .audio)
    guard prepare, current == .notDetermined else {
        return current
    }

    let semaphore = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in
        semaphore.signal()
    }
    semaphore.wait()
    return AVCaptureDevice.authorizationStatus(for: .audio)
}

private func speechAuthorizationStatus(prepare: Bool) -> SFSpeechRecognizerAuthorizationStatus {
    let current = SFSpeechRecognizer.authorizationStatus()
    guard prepare, current == .notDetermined else {
        return current
    }

    let semaphore = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { _ in
        semaphore.signal()
    }
    semaphore.wait()
    return SFSpeechRecognizer.authorizationStatus()
}

@available(macOS 26.0, *)
private func speechAnalyzerStatus(prepare: Bool) async -> ClaudettePlatformSpeechStatus {
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current) else {
        return status(
            statusUnavailable,
            engineNone,
            "Apple SpeechAnalyzer does not support the current locale."
        )
    }

    let transcriber = DictationTranscriber(locale: locale, preset: .shortDictation)
    let modules: [any SpeechModule] = [transcriber]
    let assetStatus = await AssetInventory.status(forModules: modules)
    switch assetStatus {
    case .installed:
        return status(statusReady, engineSpeechAnalyzer, "Ready via Apple SpeechAnalyzer")
    case .supported:
        guard prepare else {
            return status(
                statusNeedsAssets,
                engineSpeechAnalyzer,
                "Needs Apple SpeechAnalyzer language assets"
            )
        }
        do {
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: modules) else {
                return status(
                    statusEngineUnavailable,
                    engineSpeechAnalyzer,
                    "Apple SpeechAnalyzer assets are supported, but macOS did not provide an installation request."
                )
            }
            try await request.downloadAndInstall()
            return status(statusReady, engineSpeechAnalyzer, "Ready via Apple SpeechAnalyzer")
        } catch {
            return status(
                statusEngineUnavailable,
                engineSpeechAnalyzer,
                "Apple SpeechAnalyzer asset installation failed: \(error.localizedDescription)"
            )
        }
    case .downloading:
        return status(
            statusNeedsAssets,
            engineSpeechAnalyzer,
            "Apple SpeechAnalyzer language assets are downloading"
        )
    case .unsupported:
        return status(
            statusUnavailable,
            engineNone,
            "Apple SpeechAnalyzer is unsupported for the current locale."
        )
    @unknown default:
        return status(
            statusUnavailable,
            engineNone,
            "Apple SpeechAnalyzer returned an unknown asset status."
        )
    }
}

private func sfSpeechStatus() -> ClaudettePlatformSpeechStatus {
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current) else {
        return status(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech does not support the current locale."
        )
    }
    guard recognizer.isAvailable else {
        return status(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech recognition is not currently available."
        )
    }
    return status(statusReady, engineSFSpeech, "Ready via Apple Speech")
}

@available(macOS 26.0, *)
private func transcribeWithSpeechAnalyzer(url: URL) async throws -> String {
    let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current)
        ?? Locale(identifier: "en-US")
    let transcriber = DictationTranscriber(locale: locale, preset: .shortDictation)
    let modules: [any SpeechModule] = [transcriber]
    let audioFile = try AVAudioFile(forReading: url)
    let resultsTask = Task {
        var transcript = ""
        for try await result in transcriber.results {
            if result.isFinal {
                transcript += String(result.text.characters)
            }
        }
        return transcript
    }

    _ = try await SpeechAnalyzer(
        inputAudioFile: audioFile,
        modules: modules,
        finishAfterFile: true
    )
    return try await resultsTask.value
}

private func transcribeWithSFSpeech(url: URL) -> ClaudettePlatformSpeechTranscription {
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current) else {
        return transcriptionError(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech does not support the current locale."
        )
    }
    guard recognizer.isAvailable else {
        return transcriptionError(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech recognition is not currently available."
        )
    }

    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false

    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var transcript = ""
    var failure: String?
    var completed = false
    var task: SFSpeechRecognitionTask?

    task = recognizer.recognitionTask(with: request) { result, error in
        lock.lock()
        defer { lock.unlock() }

        if let result {
            transcript = result.bestTranscription.formattedString
            if result.isFinal && !completed {
                completed = true
                semaphore.signal()
            }
        }

        if let error, !completed {
            failure = error.localizedDescription
            completed = true
            semaphore.signal()
        }
    }

    let timeout = DispatchTime.now() + .seconds(90)
    if semaphore.wait(timeout: timeout) == .timedOut {
        task?.cancel()
        return transcriptionError(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech transcription timed out."
        )
    }

    task?.cancel()
    lock.lock()
    let finalTranscript = transcript
    let finalFailure = failure
    lock.unlock()

    if let finalFailure {
        return transcriptionError(
            statusEngineUnavailable,
            engineSFSpeech,
            "Apple Speech transcription failed: \(finalFailure)"
        )
    }
    return transcriptionSuccess(engineSFSpeech, finalTranscript)
}

private func waitForAsync<T>(_ operation: @escaping () async -> T) -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = AsyncBox<T>()
    Task {
        box.value = await operation()
        semaphore.signal()
    }
    semaphore.wait()
    return box.value!
}

private final class AsyncBox<T>: @unchecked Sendable {
    var value: T?
}

private func writeStatus(
    _ status: ClaudettePlatformSpeechStatus,
    _ code: UnsafeMutablePointer<Int32>?,
    _ engine: UnsafeMutablePointer<Int32>?,
    _ message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) {
    code?.pointee = status.code
    engine?.pointee = status.engine
    message?.pointee = status.message
}

private func writeTranscription(
    _ transcription: ClaudettePlatformSpeechTranscription,
    _ code: UnsafeMutablePointer<Int32>?,
    _ engine: UnsafeMutablePointer<Int32>?,
    _ text: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ message: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) {
    code?.pointee = transcription.code
    engine?.pointee = transcription.engine
    text?.pointee = transcription.text
    message?.pointee = transcription.message
}

private func status(
    _ code: Int32,
    _ engine: Int32,
    _ message: String
) -> ClaudettePlatformSpeechStatus {
    ClaudettePlatformSpeechStatus(code: code, engine: engine, message: copyCString(message))
}

private func transcriptionSuccess(
    _ engine: Int32,
    _ text: String
) -> ClaudettePlatformSpeechTranscription {
    ClaudettePlatformSpeechTranscription(
        code: statusReady,
        engine: engine,
        text: copyCString(text),
        message: copyCString(engine == engineSpeechAnalyzer ? "Apple SpeechAnalyzer" : "Apple Speech")
    )
}

private func transcriptionError(
    _ code: Int32,
    _ engine: Int32,
    _ message: String
) -> ClaudettePlatformSpeechTranscription {
    ClaudettePlatformSpeechTranscription(
        code: code,
        engine: engine,
        text: nil,
        message: copyCString(message)
    )
}

private func copyCString(_ value: String) -> UnsafeMutablePointer<CChar>? {
    strdup(value)
}

private func microphonePermissionMessage(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
        "Needs Microphone permission"
    case .denied, .restricted:
        "Needs Microphone permission"
    case .authorized:
        "Microphone permission granted"
    @unknown default:
        "Microphone permission status is unknown"
    }
}

private func speechPermissionMessage(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
        "Needs Speech Recognition permission"
    case .denied, .restricted:
        "Needs Speech Recognition permission"
    case .authorized:
        "Speech Recognition permission granted"
    @unknown default:
        "Speech Recognition permission status is unknown"
    }
}
